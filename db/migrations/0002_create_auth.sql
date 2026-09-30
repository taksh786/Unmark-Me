-- Unmark Me: email sign-in codes and sessions.
--
-- Codes and session tokens are stored only as hashes, so a copy of this
-- database cannot be used to sign in. Rows are short-lived: codes are deleted
-- once used or expired, sessions when the user logs out or the session ends.
--
-- Apply with:  psql "$DATABASE_URL" -f db/migrations/0002_create_auth.sql

begin;

create table login_codes (
    id          uuid primary key default gen_random_uuid(),
    email       text not null,
    code_hash   text not null,
    attempts    integer not null default 0,
    created_at  timestamptz not null default now(),
    expires_at  timestamptz not null,

    constraint login_codes_email_lowercase_check check (email = lower(email)),
    constraint login_codes_attempts_check check (attempts >= 0)
);

create index login_codes_email_created_idx on login_codes (email, created_at desc);

create table sessions (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null references users (id) on delete cascade,
    token_hash    text not null unique,
    created_at    timestamptz not null default now(),
    expires_at    timestamptz not null,
    last_seen_at  timestamptz not null default now()
);

create index sessions_user_idx on sessions (user_id);

comment on table login_codes is
    'Pending one-time email sign-in codes. Only an HMAC of the code is kept.';
comment on table sessions is
    'Signed-in browser sessions. Only a SHA-256 hash of the cookie token is kept.';

commit;
