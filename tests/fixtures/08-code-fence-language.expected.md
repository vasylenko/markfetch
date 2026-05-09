# Code fence language fixture

Many documentation generators emit syntax-highlighted code blocks with a language hint encoded in the inner code element's class attribute. Common patterns include `language-python`, `lang-js`, and Highlight.js's `hljs language-typescript`. This fixture exercises whether markfetch preserves the language hint when emitting the fenced markdown code block.

```python
def hello(name: str) -> None:
    print(f"Hello, {name}!")
```

The expected output today is a bare triple-backtick fence with no language tag. After the optional language-hint patch lands, the fence should read ` ```python `.

```javascript
const greet = (name) => {
  console.log(`Hello, ${name}!`);
};
```

A closing paragraph keeps Readability's content score comfortably above threshold for stable extraction across runs.