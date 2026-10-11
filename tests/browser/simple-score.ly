\version "2.24.4"
\header {
  title = "A little beginning"
  subtitle = "A melody to make your own"
  composer = "Score Chat"
  tagline = ##f
}
\score {
  \new Staff \relative c' {
    \clef treble
    \key c \major
    \time 4/4
    \tempo "Andante" 4 = 80
    c4\p e g e | f4 a g2 |
    e4 d c d | e2 g2 | \break
    a4\< g f e | d4 e f g\! |
    e4\> d c b | c1\! \bar "|."
  }
  \layout { }
}
