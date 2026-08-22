// miccap.swift — capture the default audio input and emit band levels as JSON.
//
// Exists because browser microphone permission is a maze: Safari will not grant
// getUserMedia on plain localhost, a self-signed cert is not trusted enough for
// device access, and the relevant Safari toggle moves between versions. A small
// native capture tool sidesteps all of it — macOS grants the permission once,
// to this process, and the page reads the result over HTTP.
//
// Emits one JSON line per analysis frame on stdout:
//   {"level":0.42,"bass":0.81,"mid":0.33,"treble":0.12}
//
// Build:  swiftc -O -o miccap miccap.swift

import AVFoundation
import Accelerate

let N = 1024                       // FFT window
let log2n = vDSP_Length(log2(Float(N)))
guard let fftSetup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else {
    FileHandle.standardError.write("fft setup failed\n".data(using: .utf8)!)
    exit(1)
}

// Hann window, to stop spectral leakage smearing the bands together.
var window = [Float](repeating: 0, count: N)
vDSP_hann_window(&window, vDSP_Length(N), Int32(vDSP_HANN_NORM))

let engine = AVAudioEngine()
let input = engine.inputNode
let format = input.outputFormat(forBus: 0)
let sampleRate = Float(format.sampleRate)

func bandEnergy(_ mags: [Float], _ loHz: Float, _ hiHz: Float) -> Float {
    let nyquist = sampleRate / 2
    let bins = Float(mags.count)
    let a = max(1, Int(loHz / nyquist * bins))
    let b = min(mags.count - 1, Int(hiHz / nyquist * bins))
    if b <= a { return 0 }
    var sum: Float = 0, peak: Float = 0
    for i in a...b {
        sum += mags[i]
        if mags[i] > peak { peak = mags[i] }
    }
    let mean = sum / Float(b - a + 1)
    // Mean alone buries sparse content (a cymbal occupies a handful of bins in
    // a wide band); peak alone is jumpy. Blend, as the browser analyser did.
    return 0.45 * mean + 0.55 * peak
}

func analyse(_ buffer: AVAudioPCMBuffer) {
    guard let ch = buffer.floatChannelData?[0] else { return }
    let count = Int(buffer.frameLength)
    if count < N { return }

    var samples = [Float](repeating: 0, count: N)
    for i in 0..<N { samples[i] = ch[i] }

    // RMS before windowing — this is loudness, not spectrum.
    var rms: Float = 0
    vDSP_rmsqv(samples, 1, &rms, vDSP_Length(N))

    vDSP_vmul(samples, 1, window, 1, &samples, 1, vDSP_Length(N))

    var real = [Float](repeating: 0, count: N / 2)
    var imag = [Float](repeating: 0, count: N / 2)
    var mags = [Float](repeating: 0, count: N / 2)

    real.withUnsafeMutableBufferPointer { rp in
        imag.withUnsafeMutableBufferPointer { ip in
            var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
            samples.withUnsafeBufferPointer { sp in
                sp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: N / 2) {
                    vDSP_ctoz($0, 2, &split, 1, vDSP_Length(N / 2))
                }
            }
            vDSP_fft_zrip(fftSetup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
            vDSP_zvabs(&split, 1, &mags, 1, vDSP_Length(N / 2))
        }
    }

    var scale = 2.0 / Float(N)
    vDSP_vsmul(mags, 1, &scale, &mags, 1, vDSP_Length(N / 2))

    let out = String(
        format: "{\"level\":%.5f,\"bass\":%.5f,\"mid\":%.5f,\"treble\":%.5f}",
        rms,
        bandEnergy(mags, 20, 250),
        bandEnergy(mags, 250, 2000),
        bandEnergy(mags, 2000, 8000)
    )
    print(out)
    fflush(stdout)
}

func run() {
    input.installTap(onBus: 0, bufferSize: UInt32(N), format: format) { buf, _ in
        analyse(buf)
    }
    do {
        try engine.start()
        FileHandle.standardError.write(
            "miccap: capturing at \(Int(sampleRate)) Hz\n".data(using: .utf8)!)
    } catch {
        FileHandle.standardError.write("engine failed: \(error)\n".data(using: .utf8)!)
        exit(1)
    }
    RunLoop.main.run()
}

// Permission is requested here rather than assumed — on first run macOS shows
// the prompt, attributed to whichever app launched this process.
switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .authorized:
    run()
case .notDetermined:
    AVCaptureDevice.requestAccess(for: .audio) { granted in
        if granted { run() }
        else {
            FileHandle.standardError.write("microphone denied\n".data(using: .utf8)!)
            exit(2)
        }
    }
    RunLoop.main.run()
default:
    FileHandle.standardError.write(
        "microphone denied — enable in System Settings > Privacy & Security > Microphone\n"
            .data(using: .utf8)!)
    exit(2)
}
