# Baseline clean article

This fixture represents the head-of-distribution use case: an editorial article with a single H1, a few H2 sections, plain paragraphs, one inline link to [example.com](https://example.com/), and a small unordered list. Nothing here exercises any edge case under repair.

## Why this matters

If a future fix to the escape policy or anchor-stripping rule causes any drift in this fixture's output, that drift is a regression — the change touched code paths it shouldn't have. This fixture is the canary for unintended long-tail damage.

## Key points

*   Plain prose with no special characters.
*   One inline link to a public domain.
*   Standard heading hierarchy.

A closing paragraph rounds out the substantive content so Readability can confidently identify the article body and emit a clean conversion.