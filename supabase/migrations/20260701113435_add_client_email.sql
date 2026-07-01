-- Add per-client login email. Used by the session-bridge signIn() to resolve
-- which client is logging in; also the natural key for real Supabase Auth later.
ALTER TABLE clients ADD COLUMN email text UNIQUE;

UPDATE clients SET email = 'james@halloran.com.au'     WHERE ref = 'C1';
UPDATE clients SET email = 'margaret.chen@outlook.com' WHERE ref = 'C2';
UPDATE clients SET email = 'office@endeavourfo.com.au' WHERE ref = 'C3';
UPDATE clients SET email = 'david.okafor@gmail.com'    WHERE ref = 'C4';
