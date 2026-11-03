// Tiny formatter for assistant text: paragraphs, "- " bullet lists,
// **bold**, and `code`. Enough for short, prepared responses.

function inline(text, keyPrefix) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith('**')) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`')) return <code key={key}>{part.slice(1, -1)}</code>;
    return part;
  });
}

export default function Markdown({ text }) {
  const blocks = [];
  let list = null;
  text.split('\n').forEach((line, i) => {
    if (line.startsWith('- ')) {
      if (!list) {
        list = [];
        blocks.push({ type: 'list', items: list, key: i });
      }
      list.push(line.slice(2));
    } else {
      list = null;
      if (line.trim()) blocks.push({ type: 'p', text: line, key: i });
    }
  });
  return (
    <div className="md">
      {blocks.map((b) =>
        b.type === 'list' ? (
          <ul key={b.key}>
            {b.items.map((item, j) => (
              <li key={j}>{inline(item, `${b.key}-${j}`)}</li>
            ))}
          </ul>
        ) : (
          <p key={b.key}>{inline(b.text, b.key)}</p>
        )
      )}
    </div>
  );
}

export { inline as formatInline };
