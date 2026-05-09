# Escape policy fixture

The protocol uses a fixed [Huffman code](https://en.wikipedia.org/wiki/Huffman_coding)-based header compression algorithm to keep responses bandwidth-efficient. The phrase above mirrors a real pattern observed on Wikipedia: a link followed immediately by a hyphenated suffix in the next text node.

Mid-prose punctuation such as _pp. 211–224_. and trailing remarks should round-trip cleanly. Hyphens, periods and equals signs in plain prose must not be backslash-escaped where CommonMark does not require it.

Function calls like read()-supporting frameworks and write()-supporting clients are reproduced as inline parentheses. The [spec](https://example.com/spec)-compliant behaviour requires no escapes for these forms.

A closing paragraph keeps Readability's score high enough to extract this fixture. The quick brown fox jumps over the lazy dog repeatedly, providing additional textual mass for scoring purposes.