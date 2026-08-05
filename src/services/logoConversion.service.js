/**
 * logoConversion.service.js
 * ===========================
 * Converts an uploaded logo file (PDF or already-a-raster-image) into a
 * PNG Buffer suitable for storing in company_details.logo_data and for
 * embedding as a base64 data URI inside voucher PDFs.
 */

import { pdf } from "pdf-to-img";

const RASTER_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

export async function normalizeLogoUpload(fileBuffer, mimeType) {
  if (!fileBuffer || !fileBuffer.length) {
    throw new Error("Empty logo file received");
  }

  if (mimeType === "application/pdf") {
    const pngBuffer = await rasterizeFirstPdfPage(fileBuffer);
    return { buffer: pngBuffer, mimeType: "image/png" };
  }

  if (RASTER_MIME_TYPES.has(mimeType)) {
    return { buffer: fileBuffer, mimeType };
  }

  throw new Error(
    `Unsupported logo file type "${mimeType}". Upload a PDF, PNG, or JPEG.`
  );
}

async function rasterizeFirstPdfPage(pdfBuffer) {
  const document = await pdf(pdfBuffer, { scale: 3 });
  for await (const pageBuffer of document) {
    return pageBuffer;
  }
  throw new Error("Uploaded PDF has no pages to render as a logo");
}