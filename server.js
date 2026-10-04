/**
 * CloudNotes — server.js
 * ---------------------------------------------------------------------------
 * A small notes app that deliberately spans two cloud layers:
 *
 *   1. COMPUTE          This Express process. It is stateless, reads all config
 *                       from environment variables, listens on $PORT and exposes
 *                       /health, so it runs unchanged on Render, Google Cloud
 *                       Run or AWS App Runner (and can be scaled horizontally).
 *
 *   2. MANAGED DATABASE MongoDB Atlas, via Mongoose. Stores notes: title,
 *                       content, tag and timestamps.
 * ---------------------------------------------------------------------------
 */
'use strict';

require('dotenv').config(); // Loads .env locally. In the cloud, real env vars are used.

const path = require('path');
const express = require('express');
const mongoose = require('mongoose');

/* -------------------------------------------------------------------------- */
/* Configuration (12-factor: everything comes from the environment)           */
/* -------------------------------------------------------------------------- */

const {
  PORT = 3000, // Render / Cloud Run / App Runner inject PORT at runtime.
  MONGODB_URI,
} = process.env;

// Fail fast with a clear message instead of crashing later with a vague one.
const missing = ['MONGODB_URI'].filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env for local development, or set them in your cloud dashboard.');
  process.exit(1);
}

const TAGS = ['Academics', 'Cloud Arch', 'Code Snippets', 'General'];

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Error carrying an HTTP status so route handlers can `throw` cleanly. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Express 4 does not catch rejected promises; this wrapper forwards them. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* -------------------------------------------------------------------------- */
/* STORAGE LAYER 1 — MongoDB Atlas (structured metadata)                      */
/* -------------------------------------------------------------------------- */

const noteSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Title is required'],
    trim: true,
    maxlength: [120, 'Title must be 120 characters or fewer'],
  },
  content: {
    type: String,
    required: [true, 'Content is required'],
    trim: true,
    maxlength: [5000, 'Content must be 5000 characters or fewer'],
  },
  tag: {
    type: String,
    enum: { values: TAGS, message: `Tag must be one of: ${TAGS.join(', ')}` },
    default: 'General',
  },
  createdAt: { type: Date, default: Date.now, index: true },
});

const Note = mongoose.model('Note', noteSchema);

/* -------------------------------------------------------------------------- */
/* COMPUTE LAYER — Express app                                                */
/* -------------------------------------------------------------------------- */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Health check. Load balancers and platforms (Render health checks, Cloud Run
 * startup/liveness probes, App Runner health checks) poll this endpoint to
 * decide whether the instance should receive traffic or be restarted.
 */
app.get('/health', (req, res) => {
  const dbStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  res.status(200).json({
    status: 'ok',
    uptime: Math.round(process.uptime()), // seconds since this instance started
    database: dbStates[mongoose.connection.readyState] || 'unknown',
    timestamp: new Date().toISOString(),
  });
});

/** GET /api/notes?tag=Academics&search=lambda — newest first. */
app.get(
  '/api/notes',
  wrap(async (req, res) => {
    const filter = {};
    const tag = typeof req.query.tag === 'string' ? req.query.tag : '';
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    if (tag && tag !== 'All') {
      if (!TAGS.includes(tag)) throw new HttpError(400, 'Unknown tag');
      filter.tag = tag;
    }
    if (search) {
      // Escaped so user input can never be interpreted as a regular expression.
      const pattern = new RegExp(escapeRegex(search.slice(0, 100)), 'i');
      filter.$or = [{ title: pattern }, { content: pattern }];
    }

    const notes = await Note.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    res.json(notes);
  })
);

/** POST /api/notes — JSON note data only; file uploads are not supported. */
app.post(
  '/api/notes',
  wrap(async (req, res) => {
    if (!req.is('application/json')) {
      throw new HttpError(415, 'Send note data as application/json. File uploads are not supported.');
    }

    const { title, content, tag } = req.body || {};
    const draft = new Note({ title, content, tag: tag || 'General' });
    await draft.validate();
    await draft.save();
    res.status(201).json(draft);
  })
);

/** DELETE /api/notes/:id — removes the Atlas document. */
app.delete(
  '/api/notes/:id',
  wrap(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw new HttpError(400, 'Invalid note id');

    const note = await Note.findById(id);
    if (!note) throw new HttpError(404, 'Note not found');

    await note.deleteOne();
    res.json({ message: 'Note deleted', id });
  })
);

// Unknown API routes return JSON rather than the default HTML error page.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/* --------------------------------- Errors ---------------------------------- */

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof mongoose.Error.ValidationError) {
    const message = Object.values(err.errors).map((e) => e.message).join(', ');
    return res.status(400).json({ error: message });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

/* -------------------------------------------------------------------------- */
/* Startup and graceful shutdown                                              */
/* -------------------------------------------------------------------------- */

async function start() {
  // Connect to the managed database first; exit if unreachable so the platform
  // restarts the container and surfaces the failure in its logs.
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('Connected to MongoDB Atlas');

  // 0.0.0.0 is required inside containers so the platform's router can reach us.
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`CloudNotes listening on port ${PORT}`);
  });

  // Platforms send SIGTERM when scaling down or deploying a new revision.
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await mongoose.connection.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref(); // Force exit if connections hang.
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('Failed to start CloudNotes:', err.message);
  process.exit(1);
});
