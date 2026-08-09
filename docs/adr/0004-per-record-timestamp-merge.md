# Per-record timestamp merge for sync conflicts

Every holding, cash account, and debt carries an `updated_at` timestamp and a `device_id`. When the app syncs, it pulls the remote copy, then for each record, compares the local and remote timestamps; the newer wins per record.

This lets the user edit on multiple browsers / devices without losing field-level changes across different records. Trade-off: simultaneous edits to the same record still race; the later write wins.
