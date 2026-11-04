# The Timeline ruler measures the timeline by its estimate, not the page's scroll height

The *Timeline ruler* places its ticks, its thumb and the point a press lands on all on one
measure: the timeline's estimated layout, each block as tall as `timelineLayout` says its own
data makes it. The page's real heights are read only to say which block is at an edge of the
screen and how far into it. The thumb is therefore not `scrollTop / scrollHeight`, as every other
scrollbar's is. Settled in [#229](https://github.com/vulle5/rails-log-reader/issues/229), amending
[#221](https://github.com/vulle5/rails-log-reader/issues/221).

## Why the ruler can't use the page's measure

Nobody knows an entry's real height until the browser lays it out, and the Timeline lays an
entry out only once it comes near the screen (`content-visibility: auto`, with each entry's
estimate as its `contain-intrinsic-size`). Until then the page *is* the estimate. Once an entry
has been seen, the page uses its real height. #221 placed ticks by the estimate, so they never
move as entries are laid out, and the thumb by the page. It accepted the gap between the two
as "a few wrapped lines per entry".

A real `rake` Run broke that. Two App log lines each dumped an email: about 78% of the
timeline, each estimated at about 48,600 px against about 57,300 px real. Every other entry was
within 20 px. The worst tick was drawn 13 strip pixels from where its entry really was, which
inside those emails is about four screens of text. Pressing the strip on that tick landed in
the email, and with the entry on screen the thumb sat clearly apart from it. A press also
settled away from the pointer, because laying out what it scrolled to changed `scrollHeight`.

The requirements were three: ticks never move as the reader scrolls, a tick sits where its
entry is so a click on it lands on that entry, and the thumb goes where the press is. With both
of the ruler's measures read off one estimate, all three hold however wrong the estimate is: a
tick lies inside the thumb exactly when its entry is on screen. Entries laid out away from the
screen change only their own real heights, which the thumb doesn't read, so it no longer jumps
when they do.

## What it costs

- Inside an entry whose estimate is off, the thumb moves at the estimate's pace rather than the
  content's (about 18% slower inside those emails), and is a little shorter there.
- The ruler must know which block each element on the page is. The Timeline tab is therefore
  rendered by walking the layout's own blocks, with one wrapper marking each. Every switch over
  block kind or event type is exhaustive, so a new kind of entry can't reach the page without an
  estimate, and so can't leave the ruler behind.
- A press into an entry not yet laid out names a share of its estimated height, which is a
  different place once the entry takes its real height. The press is held on that block and
  share, re-aimed whenever the timeline resizes while the strip is held and for a few frames
  after.
- The conversion can stop short of the page's real ends. A thumb pushed against an end of the
  strip scrolls to that end, so dragging to the bottom still resumes *Auto-scroll*.

Edge cases follow a native scrollbar: an entry arriving while the strip is held leaves what is on
screen still and moves the thumb.

## Considered options

- **Keep the split, with a settle patch for presses.** The thumb lands on the pointer, but
  ticks and thumb still disagree by however wrong the estimate is, with no bound.
- **Measure laid-out entries and correct the estimate**, for all entries or only those above a
  size. Ticks would converge on the truth but move as the reader scrolls into unmeasured areas,
  which the first requirement rules out, and a size limit would need a threshold.
- **Lay out huge entries in full.** Needs a threshold, still moves every tick below one once it
  is measured, and spends the cost `content-visibility` exists to save exactly where it is
  largest.
- **Estimate better** (measured font advances, simulated word wrap). Narrows the gap but can't
  close it: 2% of a 57k px entry is still about five strip pixels. Under this decision a better
  estimate would only even out the thumb's pace.
- **Virtualize the list** (e.g. TanStack Virtual) instead of `content-visibility`. A virtualizer
  also estimates first and measures as it renders, so it faces the same choice between moving
  ticks and converting. It can't split one huge entry. It would take off-screen entries out of
  the DOM, so out of reach of find-in-page and screen readers, and it renders almost nothing
  under happy-dom.
- **Fold long log lines behind "show all".** Caps the error any one entry can carry, but changes
  what the Timeline shows. It is filed as its own idea, and the ruler doesn't depend on it.
