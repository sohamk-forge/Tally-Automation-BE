import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { verifySession } from "supertokens-node/recipe/session/framework/express/index.js";
import { redisConnection } from "../config/redis.js";

/*
====================================
CONNECTOR INSTALLER DOWNLOAD

Two-step so the ~100MB installer is downloaded natively by the browser
(progress bar, resumable) instead of being buffered through an XHR blob:

  1. POST /api/connector-installer/link  (logged-in users only)
     -> { url } — a single-use, 60s token URL.
  2. GET  /api/connector-installer/download/:token  (public, token IS the auth)
     -> streams the installer as an attachment.

The installer itself is not stored in git. Set CONNECTOR_INSTALLER_PATH to
the .exe, or drop it into ./downloads (newest .exe there is served).
====================================
*/

const TOKEN_TTL_SECONDS = 60;
const TOKEN_KEY_PREFIX = "connector-installer-token:";
const DOWNLOADS_DIR = path.resolve(process.cwd(), "downloads");

function resolveInstallerPath() {
  const configured = process.env.CONNECTOR_INSTALLER_PATH;
  if (configured) {
    return fs.existsSync(configured) ? configured : null;
  }

  if (!fs.existsSync(DOWNLOADS_DIR)) return null;

  const newest = fs
    .readdirSync(DOWNLOADS_DIR)
    .filter((name) => name.toLowerCase().endsWith(".exe"))
    .map((name) => {
      const full = path.join(DOWNLOADS_DIR, name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)[0];

  return newest?.full ?? null;
}

export const connectorInstallerLinkRouter = express.Router();

connectorInstallerLinkRouter.post("/link", verifySession(), async (req, res) => {
  try {
    if (!resolveInstallerPath()) {
      return res.status(404).json({
        status: "error",
        message: "The connector installer is not available right now. Please contact support."
      });
    }

    const token = crypto.randomBytes(24).toString("hex");
    await redisConnection.set(`${TOKEN_KEY_PREFIX}${token}`, "1", "EX", TOKEN_TTL_SECONDS);

    return res.json({
      status: "success",
      data: { url: `/api/connector-installer/download/${token}` }
    });
  } catch (err) {
    console.error("Connector installer link error:", err);
    return res.status(500).json({ status: "error", message: "Could not prepare the download" });
  }
});

export const connectorInstallerDownloadRouter = express.Router();

connectorInstallerDownloadRouter.get("/download/:token", async (req, res) => {
  try {
    const key = `${TOKEN_KEY_PREFIX}${req.params.token}`;

    // Single use: read and delete in one round trip, so a leaked or
    // replayed URL stops working as soon as it has been used once.
    const [[, found]] = await redisConnection.multi().get(key).del(key).exec();
    if (!found) {
      return res.status(410).json({
        status: "error",
        message: "This download link has expired. Please click Download again."
      });
    }

    const installerPath = resolveInstallerPath();
    if (!installerPath) {
      return res.status(404).json({ status: "error", message: "Installer not available" });
    }

    return res.download(installerPath, path.basename(installerPath));
  } catch (err) {
    console.error("Connector installer download error:", err);
    if (!res.headersSent) {
      return res.status(500).json({ status: "error", message: "Download failed" });
    }
  }
});
