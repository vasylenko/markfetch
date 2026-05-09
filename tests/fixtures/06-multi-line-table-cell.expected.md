# Multi-line table cell fixture

The conversion table below contains cells with bullet lists and multi-line content. CommonMark pipe-tables cannot express these structurally; the converter must either fall back to raw HTML or degrade gracefully without producing a broken pipe-table.

| JSON | Python |
| --- | --- |
| object | 
*   dict
*   OrderedDict (with object_pairs_hook)

 |
| array | list |

A second substantive paragraph keeps Readability's content score above its threshold so this fixture extracts cleanly and produces a stable baseline snapshot.