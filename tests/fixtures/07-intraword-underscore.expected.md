# Intraword underscore fixture

Function signatures often italicise parameter names, producing fragments like _json.dump(obj, fp, \*, skipkeys=False, ensure_ascii=True, \*\*kw)_ in rendered docs. CommonMark's left-flanking-delimiter rule means an underscore flanked by alphanumerics on both sides cannot open emphasis, so escaping it is unnecessary noise.

This fixture verifies that `list_tools`, `create_contact`, and similar identifiers round-trip without backslash-escaped underscores. Markfetch's existing escape override drops the underscore escape; this snapshot pins that behaviour.

A third paragraph adds the substantive mass Readability's heuristics need to confidently identify this as the article body and not boilerplate.