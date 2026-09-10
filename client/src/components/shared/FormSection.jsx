export function FormSection({ children, title, variant }) {
  if (variant === 'catalog') {
    return (
      <section className="catalog-settings-section">
        <div className="catalog-settings-heading"><h4>{title}</h4></div>
        <div className="catalog-settings-content">{children}</div>
      </section>
    );
  }

  return (
    <section className="pricing-settings-section">
      <h4>{title}</h4>
      <div>{children}</div>
    </section>
  );
}
