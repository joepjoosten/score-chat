// An original lead sheet in the LilyJAZZ style. Its fonts and stylesheets load
// just in time from public/renderer/fonts/lilyjazz.
export const initialScore = String.raw`\version "2.24.4"

% A lead sheet in the LilyJAZZ style: hand-written music and chord fonts
% from the lilyjazz.ily and jazzchords.ily stylesheets.
\include "lilyjazz.ily"
\include "jazzchords.ily"

\header {
  title = "Late Light"
  subtitle = "Medium swing"
  composer = "Score Chat"
  tagline = ##f
}

harmony = \chordmode {
  f1:maj7 | g2:m7 c:7 | a1:m7 | d:7.9- |
  g1:m7 | c:7 | f2:maj7 d:7 | g:m7 c:7 |
  bes1:maj7 | bes:m7 | a:m7 | d:7 |
  g1:m7 | c:7.9- | f1:6 | g2:m7 c:7 |
}

melody = \relative c'' {
  \clef treble
  \key f \major
  \time 4/4

  \mark \default
  r8 a8 c e~ e4 d8 c | bes4 a8 g~ g2 |
  r8 e8 g c~ c4 b8 a | fis1 | \break
  r8 g8 bes d~ d4 c8 bes | a4 g8 e~ e2 |
  r8 f8 a c d4 c8 a | g2 r2 | \break

  \mark \default
  r8 d'8 f a~ a4 g8 f | e4 des8 c~ c2 |
  r8 c8 e g~ g4 f8 e | fis2. r4 | \break
  r8 bes,8 d f~ f4 e8 d | des4 c8 bes~ bes2 |
  a4. c8~ c2 | r8 g8 a bes c2 \bar "|."
}

\score {
  <<
    \new ChordNames \harmony
    \new Staff \melody
  >>
  \layout { }
}
`
