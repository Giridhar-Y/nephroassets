const BOUNDARY = "----bulkUploadTestBoundary";

export function csvPayload(csv: string, filename = "upload.csv") {
  const body =
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: text/csv\r\n\r\n` +
    `${csv}\r\n` +
    `--${BOUNDARY}--\r\n`;
  return {
    payload: body,
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` }
  };
}

export function emptyMultipartPayload() {
  return {
    payload: `--${BOUNDARY}--\r\n`,
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` }
  };
}
