import { useEffect, useState } from 'react';

export function useSourceEvidence(source, loadSource) {
  const [result, setResult] = useState(null);
  const identity = source?.category && source?.key ? source.category + '.' + source.key : null;
  useEffect(() => {
    if (!identity || !loadSource) return;
    let active = true; const controller = new AbortController();
    Promise.resolve(loadSource({ category: source.category, key: source.key }, controller.signal))
      .then(({ data }) => { if (active) setResult({ identity, data }); })
      .catch(() => { if (active) setResult({ identity, data: null }); });
    return () => { active = false; controller.abort(); };
  }, [identity, source?.category, source?.key, loadSource]);
  return result?.identity === identity ? result.data : null;
}
