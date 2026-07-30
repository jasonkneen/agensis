/*
  # Fix canvas object type constraint

  Ensures sticky notes can be persisted by including `sticky_note`
  in the canvas_objects.type check constraint.
*/

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'canvas_objects'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%type%IN%rect%ellipse%diamond%arrow%line%pen%text%image%video%file%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE canvas_objects DROP CONSTRAINT %I', constraint_name);
  END IF;

  BEGIN
    ALTER TABLE canvas_objects
      ADD CONSTRAINT canvas_objects_type_check
      CHECK (type IN ('rect', 'ellipse', 'diamond', 'arrow', 'line', 'pen', 'text', 'image', 'video', 'file', 'sticky_note'));
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
END $$;
