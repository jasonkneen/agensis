/*
  # Lookup user by email function

  1. New Functions
    - `lookup_user_by_email(lookup_email text)` - allows authenticated users
      to find other users by email for sharing purposes
    - Returns only the user's id and email (no sensitive data)
    - Uses SECURITY DEFINER to access auth.users safely

  2. Security
    - Only accessible to authenticated users
    - Returns minimal data (id, email only)
*/

CREATE OR REPLACE FUNCTION lookup_user_by_email(lookup_email text)
RETURNS TABLE (id uuid, email text) AS $$
BEGIN
  RETURN QUERY
  SELECT au.id, au.email::text
  FROM auth.users au
  WHERE au.email = lookup_email
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION lookup_user_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_user_by_email(text) TO authenticated;
