# L4 full-detail snapshot storage

Each snapshot stores the full holdings, cash accounts, and debts at the moment of capture, plus the per-holding price and the FX rate used. The snapshot is self-contained.

This supports "what did I have then" and grouping by current attribute values without re-fetching historical prices. Trade-off: snapshot storage grows linearly with portfolio size and snapshot count. Acceptable for the personal-use scope; could be trimmed or compacted later if needed.
