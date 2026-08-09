# Attribute references in snapshots, not values

Snapshots store attribute values as opaque category-value IDs, not as strings. When viewing a snapshot, the viewer looks up the current value of each ID from the categories definition.

This means renaming a category value (e.g. `科技` → `科技股`) retroactively affects all snapshots. Categorical data is treated as live, not frozen. Trade-off: deleting a category value leaves orphaned IDs in old snapshots; the viewer must handle the missing case.
