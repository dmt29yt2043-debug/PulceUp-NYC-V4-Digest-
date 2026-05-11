import { type NextRequest } from 'next/server';
import { getEvents } from '@/lib/db';
import type { FilterState } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;

    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const page_size = Math.min(600, Math.max(1, parseInt(searchParams.get('page_size') || '20', 10) || 20));

    const filters: FilterState & { page: number; page_size: number } = {
      page,
      page_size,
    };

    const categoriesParam = searchParams.get('categories');
    if (categoriesParam) {
      filters.categories = categoriesParam.split(',').map((s) => s.trim());
    }

    // Support both camelCase and snake_case param names
    const excludeCategoriesParam = searchParams.get('excludeCategories') || searchParams.get('exclude_categories');
    if (excludeCategoriesParam) {
      filters.excludeCategories = excludeCategoriesParam.split(',').map((s) => s.trim());
    }

    const priceMin = searchParams.get('price_min');
    if (priceMin !== null && priceMin !== '') filters.priceMin = parseFloat(priceMin);

    const priceMax = searchParams.get('price_max');
    if (priceMax !== null && priceMax !== '') filters.priceMax = parseFloat(priceMax);

    const isFree = searchParams.get('is_free');
    if (isFree !== null) filters.isFree = isFree === 'true';

    const age = searchParams.get('age');
    if (age) filters.ageMax = parseInt(age, 10);

    // Multi-child filter: comma-separated list of ages, e.g. "5,9".
    // When provided, this overrides single-age behavior — events must
    // suit at least one of the children.
    const childAgesParam = searchParams.get('child_ages');
    if (childAgesParam) {
      const ages = childAgesParam
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 18);
      if (ages.length > 0) filters.childAges = ages;
    }

    // Child genders for gender-fit filtering
    const childGendersParam = searchParams.get('child_genders');
    if (childGendersParam) {
      const genders = childGendersParam
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((g): g is 'boy' | 'girl' => ['boy', 'girl'].includes(g));
      if (genders.length > 0) filters.childGenders = genders;
    }

    const dateFrom = searchParams.get('date_from');
    if (dateFrom) filters.dateFrom = dateFrom;

    const dateTo = searchParams.get('date_to');
    if (dateTo) filters.dateTo = dateTo;

    const lat = searchParams.get('lat');
    const lon = searchParams.get('lon');
    const distance = searchParams.get('distance');
    if (lat && lon && distance) {
      filters.lat = parseFloat(lat);
      filters.lon = parseFloat(lon);
      filters.distance = parseFloat(distance);
    }

    const search = searchParams.get('search');
    if (search) filters.search = search;

    const neighborhoods = searchParams.get('neighborhoods');
    if (neighborhoods) filters.neighborhoods = neighborhoods.split(',').map((s) => s.trim());

    const ratingMin = searchParams.get('rating_min');
    if (ratingMin !== null && ratingMin !== '') filters.ratingMin = parseFloat(ratingMin);

    // Accessibility filters — accepted as snake_case from client / camelCase
    // for compatibility with chat-extracted FilterState bodies. Without this,
    // the URL param was silently dropped (Bug #2 in QA-REPORT.md).
    const stroller = searchParams.get('stroller_friendly') ?? searchParams.get('strollerFriendly');
    if (stroller === 'true') filters.strollerFriendly = true;

    const wheelchair = searchParams.get('wheelchair_accessible') ?? searchParams.get('wheelchairAccessible');
    if (wheelchair === 'true') filters.wheelchairAccessible = true;

    const result = getEvents(filters);

    return Response.json({
      total: result.total,
      page,
      page_size,
      events: result.events,
    });
  } catch (error) {
    console.error('Error fetching events:', error);
    return Response.json({ error: 'Failed to fetch events' }, { status: 500 });
  }
}
