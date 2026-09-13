const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

function presentCsvDownload(fileName, csv) {
  return {
    body: `\uFEFF${csv}`,
    contentType: CSV_CONTENT_TYPE,
    contentDisposition: `attachment; filename="${fileName}"`,
  };
}

function sendCsvDownload(res, presentation) {
  res.setHeader('Content-Type', presentation.contentType);
  res.setHeader('Content-Disposition', presentation.contentDisposition);
  return res.send(presentation.body);
}

module.exports = {
  CSV_CONTENT_TYPE,
  presentCsvDownload,
  sendCsvDownload,
};
