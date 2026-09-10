export function ValidationIssues({ issues }) {
  if (issues.length === 0) return null;

  return (
    <div className="danger-panel p-5 fade-up stagger-1">
      <div className="font-semibold text-rose-700 mb-2">Авто-валідатор виявив проблеми</div>
      <ul className="list-disc pl-5 text-sm text-rose-700">
        {issues.map((issue, index) => (
          <li key={index}>{issue}</li>
        ))}
      </ul>
    </div>
  );
}
