-- Migration: 006_set_super_admin
-- Description: Promote Im@mister-raw.com to super_admin role

UPDATE users SET role = 'super_admin', updated_at = NOW()
WHERE LOWER(email) = LOWER('Im@mister-raw.com');
