export interface Event {
  id: number;
  title: string;
  short_title: string;
  tagline: string;
  description: string;
  source_url: string;
  image_url: string;
  venue_name: string;
  subway: string;
  address: string;
  city: string;
  lat: number | null;
  lon: number | null;
  next_start_at: string;
  next_end_at: string;
  age_min: number | null;
  age_label: string;
  age_best_from: number | null;
  age_best_to: number | null;
  is_free: boolean;
  price_summary: string;
  price_min: number;
  price_max: number;
  category_l1: string;
  categories: string[];
  tags: string[];
  reviews: ReviewItem[];
  derisk: DeriskInfo;
  rating_avg: number;
  rating_count: number;
  data: EventData;
  // Per-request: which of the user's children (by age) this event suits.
  // Set only when the request includes child_ages and there are >=2 children.
  fit_child_ages?: number[];
}

export interface ReviewItem {
  text: string;
  source?: string;
}

export interface DeriskInfo {
  crowds?: string;
  verdict?: string;
  duration?: string;
  price_info?: string;
  what_you_get?: string;
  practical_tips?: string;
  what_to_expect?: string;
  how_to_get_there?: string;
  who_its_best_for?: string;
  tickets_availability?: string;
}

export interface EventData {
  includes?: string[];
  addons?: string[];
  duration_minutes?: number;
  venue_venue_type?: string;
  organizer_name?: string;
  venue_website?: string;
  venue_phone?: string;
  venue_stroller_friendly?: boolean;
  venue_wheelchair_accessible?: boolean;
  venue_accessibility_notes?: string;
  is_sold_out?: boolean;
  tickets_available?: number;
}

export interface FilterChild {
  age: number;
  gender: 'boy' | 'girl';
}

export interface FilterState {
  categories?: string[];
  excludeCategories?: string[];
  priceMin?: number;
  priceMax?: number;
  isFree?: boolean;
  ageMax?: number;
  childAges?: number[];
  childGenders?: ('boy' | 'girl')[];
  filterChildren?: FilterChild[];
  dateFrom?: string;
  dateTo?: string;
  lat?: number;
  lon?: number;
  distance?: number;
  search?: string;
  neighborhoods?: string[];
  location?: string;
  ratingMin?: number;
  wheelchairAccessible?: boolean;
  strollerFriendly?: boolean;
}

export interface ChildProfile {
  age: number;
  gender: 'boy' | 'girl' | 'unknown';
  name?: string;
  interests: string[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  events?: Event[];
  filters?: FilterState;
  quickReplies?: string[];
  childSummary?: ChildProfile[];
  interestSummary?: ChildProfile[];
  showSkip?: boolean;
  showDone?: boolean;
}

export interface UserProfile {
  children: ChildProfile[];
  neighborhoods: string[];
  budget: string;
  specialNeeds?: string;
}
