export interface Destination { code: string; name: string; countryName?: string }
export interface SearchState {
  destination: Destination | null;
  keyword: string;
  category?: { code: string; name: string };
}
export interface SkuData {
  sku_code: string;
  title: string;
  sku_type?: string;
  min_age?: number | null;
  max_age?: number | null;
  sku_min_pax?: number;
  sku_max_pax?: number;
  required?: boolean;
  [key: string]: unknown;
}
export interface PackageData {
  package_code: string;
  package_name: string;
  package_min_pax?: number;
  package_max_pax?: number;
  cancellation_type?: number;
  cancellation_desc?: string;
  voucher_usage?: number;
  voucher_usage_desc?: string;
  timeslot_type?: number;
  instant?: number;
  ticket_type?: number;
  is_open_date?: number;
  time_zone?: string;
  sections?: Record<string, unknown>[];
  sku_list: SkuData[];
  contact_info?: Record<string, unknown>[];
  spec_attrs?: Record<string, unknown>[];
  [key: string]: unknown;
}
export interface ProductDetailData {
  product_code: string;
  title: string;
  subtitle?: string;
  description?: string;
  supported_languages?: string[];
  available_date?: string;
  location?: string;
  address?: string;
  currency?: string | null;
  price?: string | null;
  images?: { image_url: string; image_type?: string }[];
  city_info?: Record<string, unknown>[];
  category_info?: Record<string, unknown>;
  sections?: Record<string, unknown>[];
  package_list: PackageData[];
  duration?: Record<string, unknown>[];
  offer_layout?: Record<string, unknown>;
  calendar_status?: string;
  [key: string]: unknown;
}
export interface BookingSelection {
  product: ProductDetailData;
  package: PackageData;
  date: string;
  time: string;
  skus: { sku_code: string; title: string; count: number; price: string; currency: string }[];
  total: number;
  currency: string;
  extraInfo: unknown;
}
export interface ExtraField {
  key: string;
  name?: string;
  description?: string;
  input_type?: string;
  required?: boolean;
  options?: { key: string; name?: string; label?: string; value?: string }[];
  validation_rules?: Record<string, unknown>;
  [key: string]: unknown;
}
