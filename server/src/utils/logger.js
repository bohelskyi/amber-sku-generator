function write(level, event, context = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...context,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = {
  error: (event, context) => write('error', event, context),
  info: (event, context) => write('info', event, context),
  warn: (event, context) => write('warn', event, context),
};
