# Google Drive as sync backend

The portfolio is stored as a single JSON file in the user's Google Drive, accessed via the Drive REST API with `drive.file` scope. The app never runs a server; the user's own Drive is the backend.

Sync is pull-on-open, push-on-save. No real-time sync, no server-side merge. Conflicts are resolved at the client (see ADR-0004). Trade-off: simultaneous edits across devices can race; mitigated by per-record timestamps.
