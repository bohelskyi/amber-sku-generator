// A small external display cache, owned by the mounted principal/workspace.
// The API deliberately has no way to carry preview evidence or request identity.
export function createExportViewMemory() {
  let value = null;
  return Object.freeze({
    read: () => value,
    clear: () => { value = null; },
    update: (next) => {
      const merged = { ...value, ...next };
      value = Object.fromEntries(['group', 'search', 'attention', 'language', 'page', 'widths', 'productChanged', 'autoRecheck', 'returnReview']
        .filter((key) => Object.hasOwn(merged, key)).map((key) => [key, merged[key]]));
    },
  });
}
