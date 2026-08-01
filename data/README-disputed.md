# disputed-areas.json

79 territories whose sovereignty is contested, drawn as a hatched overlay on the
map by `drawDisputedAreas()` in `app.js`.

## Why it exists separately

The base map is `world-atlas@2/countries-110m.json`, which draws one set of
present-day borders and says nothing about which of them anyone disagrees with.
It happens to carry Taiwan, Palestine, Kosovo, W. Sahara, N. Cyprus and
Somaliland as separate country shapes, but **not** Kashmir, Crimea, the Golan
Heights, Abkhazia or Nagorno-Karabakh -- those are folded into a neighbour.

Marking only the ones the atlas happened to split out would have read as an
editorial line rather than an omission, which is worse than marking none. Hence
Natural Earth's dedicated disputed-areas dataset, which covers all of them.

## Source and filtering

`ne_10m_admin_0_disputed_areas` from
<https://github.com/nvkelso/natural-earth-vector> (Natural Earth, public
domain). 99 features, filtered to `TYPE` in {Disputed, Breakaway,
Indeterminate} -- which drops leases (Guantanamo, Baikonur), overlays (the
Korean DMZ) and plain geo units, none of which are sovereignty disputes.

Each feature keeps two fields:

- `n` -- `BRK_NAME`, the territory's own name ("Jammu and Kashmir", "Aksai
  Chin", "Crimea"), not the claimant's.
- `d` -- `NOTE_BRK`, Natural Earth's wording: "Admin. by India; Claimed by
  Pakistan". Shown verbatim on hover. Who administers a territory and who claims
  it are both checkable facts, and stating both is the only position this site is
  entitled to take. Nothing here is worded by us.

## Two things that will bite you on regeneration

**Winding order.** `d3.geoPath` reads a ring wound the wrong way as the whole
sphere *minus* the shape, so one bad ring paints the entire map orange. Exterior
rings must be clockwise (negative shoelace area on lon/lat), holes the other way.
Exactly one ring in the source needs flipping; without it the map looks
catastrophically broken rather than subtly wrong.

**Size.** Raw is 701KB. Rounding coordinates to 2dp (about a kilometre, under a
third of a pixel even at maximum zoom) gets it to 181KB, ~40KB gzipped -- the
same weight as the country atlas.

## Regenerate

    curl -s -o /tmp/disputed.geojson \
      https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_10m_admin_0_disputed_areas.geojson

then filter, round, and rewind as above. Bump the `?v=` on the fetch in
`app.js`.
