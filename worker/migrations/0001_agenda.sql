CREATE TABLE IF NOT EXISTS agenda (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
    events TEXT NOT NULL
        CHECK (json_valid(events) AND json_type(events) = 'array')
        CHECK (length(CAST(events AS BLOB)) <= 1048576)
);
