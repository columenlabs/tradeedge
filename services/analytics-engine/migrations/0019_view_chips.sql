-- Custom view chips carry where they show (Bikram, 2026-10-09): each chip is {key, placement}, with
-- placement `column` (its own column) or `inline` (on the view's first column). Views saved with a
-- plain list of keys keep their chips in their own columns.
UPDATE custom_views
SET config = json_set(
  config,
  '$.chips',
  (SELECT json_group_array(json_object('key', value, 'placement', 'column'))
   FROM json_each(custom_views.config, '$.chips'))
)
WHERE json_array_length(config, '$.chips') > 0
  AND json_type(config, '$.chips[0]') = 'text';
