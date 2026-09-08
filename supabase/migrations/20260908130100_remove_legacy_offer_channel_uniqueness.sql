alter table public.published_offers
  drop constraint if exists published_offers_offer_channel_unique;
