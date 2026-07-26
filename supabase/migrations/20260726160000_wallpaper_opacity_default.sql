-- Wallpaper opacity default: 0.42 -> 0.7
--
-- 0.42 made a wallpaper neither a wallpaper nor a clean surface: it read as a
-- raised translucent pane floating over the app background. The owner asked
-- what the odd surface on the entry page was, which is the clearest possible
-- signal that a default is wrong.
--
-- Rows holding EXACTLY 0.42 are the ones the old column default wrote, i.e.
-- nobody ever chose for themselves — a hand-picked slider value is almost never
-- exactly that. Those move. Anything else is somebody's decision and is left
-- alone.

alter table workspaces alter column background_opacity set default 0.7;
alter table canvas_layers alter column background_opacity set default 0.7;

update workspaces set background_opacity = 0.7 where background_opacity = 0.42;
update canvas_layers set background_opacity = 0.7 where background_opacity = 0.42;
