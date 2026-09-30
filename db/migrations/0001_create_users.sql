-- Unmark Me: user accounts.
--
-- Stores only what sign-in and plans need. Images and videos are processed in
-- the browser and never uploaded, so there is no file, job or history table.
-- Usage is two counters for the current allowance window, which the app resets
-- when the window rolls over:
--   free:      a calendar day (UTC)   -> 3 images, 1 video
--   pro / max: the billing period     -> 200 images, 100 videos / fair use
--
-- Apply with:  psql "$DATABASE_URL" -f db/migrations/0001_create_users.sql

begin;

create type plan_tier as enum ('free', 'pro', 'max');
create type billing_period as enum ('monthly', 'annual');
create type subscription_status as enum ('active', 'trialing', 'past_due', 'canceled');

create table users (
    id                  uuid primary key default gen_random_uuid(),

    -- Identity
    email               text not null,
    email_verified      boolean not null default false,
    display_name        text,
    avatar_url          text,
    auth_provider       text not null,
    auth_subject        text not null,

    -- Plan and billing
    plan                plan_tier not null default 'free',
    billing_period      billing_period,
    subscription_status subscription_status,
    billing_customer_id text,
    current_period_end  timestamptz,

    -- Usage in the current allowance window
    usage_window_start  timestamptz not null default now(),
    images_used         integer not null default 0,
    videos_used         integer not null default 0,

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    last_sign_in_at     timestamptz,

    constraint users_auth_provider_check
        check (auth_provider in ('google', 'email')),
    constraint users_email_format_check
        check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
    constraint users_display_name_length_check
        check (char_length(display_name) between 1 and 120),
    constraint users_usage_non_negative_check
        check (images_used >= 0 and videos_used >= 0),
    constraint users_free_plan_has_no_billing_check
        check (plan <> 'free' or (
            billing_period is null and
            subscription_status is null and
            current_period_end is null
        )),
    constraint users_paid_plan_has_billing_check
        check (plan = 'free' or (
            billing_period is not null and
            subscription_status is not null
        ))
);

-- One account per email, whatever the letter case. Signing in with a second
-- method for the same email should link to this row, not create another.
create unique index users_email_key on users (lower(email));
create unique index users_auth_identity_key on users (auth_provider, auth_subject);
create unique index users_billing_customer_key on users (billing_customer_id)
    where billing_customer_id is not null;

create function set_updated_at() returns trigger
language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

create trigger users_set_updated_at
    before update on users
    for each row execute function set_updated_at();

comment on table users is
    'Unmark Me accounts. No files or processing history are stored; deleting a row removes everything about the user.';
comment on column users.auth_subject is
    'The sign-in provider''s stable id for this user (for example the Google "sub" claim).';
comment on column users.billing_customer_id is
    'Customer id at the payment provider, set once the user starts a paid plan.';
comment on column users.usage_window_start is
    'Start of the current allowance window: the UTC day for free, the billing period for paid plans.';

commit;
