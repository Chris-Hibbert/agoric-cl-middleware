--------------------------------------------------------------------------------
-- Up
--------------------------------------------------------------------------------

ALTER TABLE jobs
ADD COLUMN last_tried_round INTEGER DEFAULT 0;

--------------------------------------------------------------------------------
-- Down
--------------------------------------------------------------------------------

;