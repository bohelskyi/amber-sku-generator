export function downloadBlob(blob, fileName, { documentRef = document, urlApi = URL } = {}) {
  const url = urlApi.createObjectURL(blob);
  const anchor = documentRef.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  documentRef.body.appendChild(anchor);

  try {
    anchor.click();
  } finally {
    anchor.remove();
    urlApi.revokeObjectURL(url);
  }
}
