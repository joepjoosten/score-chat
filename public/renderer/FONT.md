# Bundled Emmentaler font

The browser renderer includes the unmodified `emmentaler-20.svg` from the
LilyPond TypeScript repository. Its source is the official LilyPond 2.24.4
Darwin x86_64 release archive.

- Archive: `lilypond-2.24.4-darwin-x86_64.tar.gz`
- [Release download](https://gitlab.com/lilypond/lilypond/-/releases/v2.24.4/downloads/lilypond-2.24.4-darwin-x86_64.tar.gz)
- Archive SHA-256: `84a1e6173afd8f1eda1e39c610a498c41aa20975b4ffaad2e2b2810a52da90b8`
- Original SVG SHA-256: `033ec58d65a158526a3d89e55fd01174516f4bad706383c84c6bf1a28ac6f63e`

The source distribution identifies Emmentaler and Feta as Font Software under
the SIL Open Font License 1.1. `LICENSE.OFL` preserves that license. The SVG
also retains an older embedded GPL notice and font exception; the GPLv3 text
is preserved in `COPYING`. The original font sources are available in the
[LilyPond 2.24.4 source tree](https://gitlab.com/lilypond/lilypond/-/tree/v2.24.4/mf).

# Optional LilyJAZZ fonts

`fonts/lilyjazz/` holds the unmodified LilyJAZZ music font (`lilyjazz-*.svg`
and `.otf`, every optical size and the brace font), the LilyJAZZ Text and
Chord fonts, and the `lilyjazz.ily`, `jazzchords.ily` and `jazzextras.ily`
stylesheets from [OpenLilyPondFonts/lilyjazz](https://github.com/OpenLilyPondFonts/lilyjazz)
(revision in `fonts/lilyjazz/version.json`). The worker downloads a file only
when a score uses it.

The text and chord fonts are under the SIL Open Font License 1.1
(`lilyjazz-text-OFL.txt`, `lilyjazz-chord-OFL.txt`, with their FONTLOGs). The
repository describes the music font's licensing as not completely clear and
treats it as released under LilyPond's license (GPL); see `fonts/lilyjazz/LICENSE`
and `FONTLOG.txt`, and `COPYING` for the GPLv3 text.
