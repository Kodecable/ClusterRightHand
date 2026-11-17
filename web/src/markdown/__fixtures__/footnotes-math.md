# Footnotes and math in a streamed message

This report mixes ordinary Markdown with footnotes and formulas so the incremental splitter meets
both at once. The first reference[^intro] comes before its definition, and the same label shows up
again[^intro] in a later paragraph. A note with a wrapped body[^long] is referenced from here too.

## Early inline math

The identity \(e^{i\pi} + 1 = 0\) and the pair $$a+b$$ both render inline, while a single dollar
stays money: the budget is $5 and $10 for two nodes. An escaped bracket mid-line, like \[link\] in
this sentence, is literal text and must not split the paragraph.

> **Note**
> A blockquote can hold prose and a reference[^quoted] that is defined further down, after the
> formula below.

## Display math

$$
\sum_{i=1}^{n} x_i = \frac{n(n+1)}{2}

\quad\text{for every } n \ge 1
$$

The formula above contains a blank line and still streams as one block. A line-own formula can stay
on a single line:

\[F = ma\]

A multi-line piece of display math follows:

\[
E = mc^2
\]

and the aligned form:

\[
\begin{aligned}
a &= b + c \\
d &= e - f
\end{aligned}
\]

## A table of values

| node | pods | cpu | formula |
| --- | --- | --- | --- |
| worker-01 | 42 | 61% | \(x^2\) |
| worker-02 | 38 | 58% | $$y+1$$ |
| worker-03 | 51 | 77% | \(z-1\) |

## Roll-out checklist

The table above is followed by an ordinary ordered list, to keep the splitter on its usual paths
between the math blocks.

1. Drain the first node and confirm the queue depth stays flat for one minute.
2. Apply the new manifest with `kubectl apply -f manifest.yaml`.
3. Watch the rollout for \(t < 120\) seconds and abort if the error rate rises.
4. Repeat for each zone, recording the observed \(p99\) latency.

> A blockquote does not need to contain math to matter here. It is a container the block splitter
> must keep together while the reference[^quoted] inside it resolves from a definition below.

The blockquote note[^quoted] is referenced again in the Footnotes section, after its definition,
which exercises the message-wide numbering rather than the per-block numbering.

## A list with indented display math

- Capacity check for the first node:

  \[
  \frac{used}{capacity} \ge 0.8
  \]

- The Pythagorean identity stays inside the next item:

  \[a^2 + b^2 = c^2\]

- A second item keeps \(r\) inline.
- A third item ends the list.

[^quoted]: A note referenced from the blockquote.

## Footnotes

The first note was defined after two references[^intro], and the uppercase label[^Note] below is
folded to the same anchor as a lowercase reference. A non-ASCII label[^注释] covers percent
encoding. The note from the blockquote[^quoted] is already defined above.

[^intro]: The first note, referenced before this definition.
[^NOTE]: Uppercase labels fold together.

[^注释]: 这是注释，包含中文。

[^long]: A definition with an indented continuation line
    that belongs to the same note body.

The mid-document definition[^middle] appears before this line and is collected out of place.

[^middle]: A note defined in the middle of the message.

## Code is not math

Inline code keeps its delimiters: `\(x\)`, `\[y\]`, `$$z$$`, and `[^not-a-footnote]` stay text.
Fenced code is copied verbatim too:

```tex
$$
\frac{a}{b}
$$
\(x\) and \[y\]
[^not-a-footnote]: not a definition
```

## Invalid and unclosed math

Invalid TeX shows its source instead of a broken formula: $${$$.

A stray opener near the end is not a formula in a finished message:

$$
this line never closes

After the stray opener, ordinary paragraphs still render, with **bold** text and a final
reference[^intro].

[^late]: A definition after the stray opener is still collected.
