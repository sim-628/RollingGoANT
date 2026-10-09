"""Offline browser fixtures taken from the supplier's OpenAPI response examples.

This module is imported only by browser tests. It never connects to the supplier.
Dates are shifted into the requested calendar window; sold-out and price-change
variants exercise states that the real API contract supports.
"""

from copy import deepcopy
from datetime import date, timedelta
import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse


EXAMPLES = json.loads(
    (Path(__file__).parent / "fixtures" / "dida-official-examples.json").read_text()
)

TEST_IMAGE = '''<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600" viewBox="0 0 900 600">
<defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#accbdd"/><stop offset="1" stop-color="#507988"/></linearGradient></defs>
<rect width="900" height="600" fill="url(#g)"/><path d="M0 390 165 310 340 420 540 270 900 350V600H0" fill="#466b4c"/>
<path d="M490 280V145H615V280" fill="#ebe4d4"/><path d="M455 145 555 75 650 145" fill="#3e4c5a"/>
<text x="35" y="555" font-family="sans-serif" font-size="25" fill="white">Official API example image · browser test fixture</text>
</svg>'''.encode("utf-8")


class FixtureRouter:
    """Intercept every browser API call, record the request, and forbid surprises."""

    def __init__(self, origin: str, *, fail_products=False, price_change=False, quote_change_only=False, empty_unit_rules=False):
        self.origin = origin.rstrip("/")
        self.fail_products = fail_products
        self.price_change = price_change
        self.quote_change_only = quote_change_only
        self.empty_unit_rules = empty_unit_rules
        self.requests = []
        self.unexpected = []
        self.calendar_days = []
        self.validation_count = 0
        self.repriced_units = {}

    def install(self, context):
        context.route("**/*", self.handle)

    @staticmethod
    def fulfill(route, response, status=200):
        route.fulfill(status=status, content_type="application/json", body=json.dumps(response))

    def quote(self, payload):
        result = deepcopy(EXAMPLES["validate"])
        quote = result["data"]["quote"]
        quote["items"] = []
        total = 0.0
        for item in payload.get("items", []):
            lines = []
            subtotal = 0.0
            for line in item.get("sku_list", []):
                price = float(line.get("acceptable_price", "79.00"))
                if self.price_change or self.quote_change_only:
                    price = self.repriced_units.setdefault(line["sku_code"], price + 6.0)
                count = line["count"]
                subtotal += price * count
                lines.append({"sku_code": line["sku_code"], "count": count,
                              "selling_unit_price": f"{price:.2f}"})
            quote["items"].append({"package_code": item["package_code"],
                                   "start_time": item["start_time"], "currency": "USD",
                                   "selling_total": f"{subtotal:.2f}", "sku_list": lines})
            total += subtotal
        quote["total_amount"] = f"{total:.2f}"
        return result

    @staticmethod
    def assert_extra_answers(fields):
        assert isinstance(fields, list), "Extra answers must be an array"
        for field in fields:
            assert isinstance(field, dict) and isinstance(field.get("key"), str), "Every extra answer needs its field key"
            assert "value" not in field, "The supplier accepts content/selected, not flat value answers"
            assert "content" in field or "selected" in field, "Extra answers need content or selected"
            if "content" in field:
                assert isinstance(field["content"], str), "Text answer content must be a string"
            if "selected" in field:
                assert isinstance(field["selected"], list) and field["selected"], "Selected answers must retain their option tree"
                FixtureRouter.assert_extra_answers(field["selected"])

    @staticmethod
    def assert_order_wire(payload):
        for item in payload["items"]:
            FixtureRouter.assert_extra_answers(item.get("booking_extra_info", []))
            units = item.get("unit_extra_info")
            assert isinstance(units, list), "Every traveller needs a unit entry, including when field rules are empty"
            assert len(units) == sum(sku["count"] for sku in item["sku_list"]), "Traveller entries must match SKU quantities"
            for sku in item["sku_list"]:
                matching = [unit for unit in units if unit.get("sku_code") == sku["sku_code"]]
                assert sorted(unit.get("index", 0) for unit in matching) == list(range(1, sku["count"] + 1)), "Traveller index must be one-based within its SKU"
            for unit in units:
                assert "unit_index" not in unit, "The live contract uses index, not unit_index"
                FixtureRouter.assert_extra_answers(unit.get("extra_info", []))

    def handle(self, route):
        request = route.request
        parsed = urlparse(request.url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        path = parsed.path
        if request.url == "https://cdn.example/banner.jpg":
            route.fulfill(status=200, content_type="image/svg+xml", body=TEST_IMAGE)
            return
        if origin != self.origin:
            self.unexpected.append(f"External request blocked: {request.method} {origin}{path}")
            route.abort()
            return
        if not path.startswith("/api/"):
            route.continue_()
            return
        params = parse_qs(parsed.query)
        payload = request.post_data_json if request.post_data else None
        self.requests.append({"method": request.method, "path": path, "params": params, "body": payload})
        mapping = {
            "/api/catalog/cities": "cities",
            "/api/catalog/countries": "countries",
            "/api/catalog/products/10549": "product_detail",
            "/api/catalog/packages/extra-info": "extra_info",
        }
        if path in mapping:
            response = deepcopy(EXAMPLES[mapping[path]])
            if self.empty_unit_rules and path == "/api/catalog/packages/extra-info":
                for package in response["data"]:
                    package["unit_extra_info"] = []
            self.fulfill(route, response)
        elif path == "/api/catalog/categories":
            self.fulfill(route, {"success": True, "data": []})
        elif path == "/api/health":
            self.fulfill(route, {"success": True, "data": {"status": "ok", "order_mode": "validate"}})
        elif path == "/api/catalog/products":
            if self.fail_products:
                self.fulfill(route, {"success": False, "error": {"code": "TEMPORARY_FAILURE", "message": "商品信息暂时无法加载，请稍后重试。"}}, 503)
                return
            response = deepcopy(EXAMPLES["products"])
            response["data"].update(total=1, has_next=False)
            self.fulfill(route, response)
        elif path == "/api/catalog/prices":
            # This application-owned summary uses the official example's
            # USD 79.00 adult calendar quote. Backend tests verify aggregation;
            # this fixture verifies how the returned summary is displayed.
            calendar = EXAMPLES["calendar"]["data"][0]
            example_price = calendar["calendars"][0]["dates"][0]["selling_price"]
            product_code = EXAMPLES["product_detail"]["data"]["product_code"]
            first = date.today()
            summaries = []
            for code in params.get("product_codes", [""])[0].split(","):
                known = code == product_code
                summaries.append({"product_code": code, "status": "ready" if known else "unavailable",
                                  "price": example_price if known else None,
                                  "currency": calendar["currency"] if known else None,
                                  "start_date": first.isoformat(),
                                  "end_date": (first + timedelta(days=89)).isoformat(),
                                  "basis": "adult_or_general_unit"})
            self.fulfill(route, {"success": True, "data": {"prices": summaries}})
        elif path == "/api/catalog/skus/calendar":
            requested_start = date.fromisoformat(params["start_date"][0][:10])
            requested_end = date.fromisoformat(params["end_date"][0][:10])
            first = max(requested_start, date.today())
            days = [first + timedelta(days=offset) for offset in range(3)
                    if first + timedelta(days=offset) <= requested_end]
            # Package cards request one day; they must not replace the full
            # calendar's sold-out / higher-price dates used by booking checks.
            if requested_start != requested_end:
                self.calendar_days = [day.isoformat() for day in days]
            price_days = self.calendar_days or [(first + timedelta(days=offset)).isoformat() for offset in range(3)]
            sku = deepcopy(EXAMPLES["calendar"]["data"][0])
            sku["calendars"] = []
            for day in days:
                index = price_days.index(day.isoformat()) if day.isoformat() in price_days else 0
                price, stock = ["79.00", "79.00", "85.00"][index], [9999, 0, 5000][index]
                month = day.strftime("%Y-%m")
                target = next((entry for entry in sku["calendars"] if entry["month"] == month), None)
                if target is None:
                    target = {"month": month, "dates": []}
                    sku["calendars"].append(target)
                target["dates"].append({"date": f"{day.isoformat()} 00:00:00", "selling_price": price,
                                         "inventory": stock,
                                         "cutoff_time_utc": f"{day.isoformat()} 23:59:59"})
            self.fulfill(route, {"success": True, "data": [sku]})
        elif path == "/api/availability-check" and request.method == "POST":
            response = deepcopy(EXAMPLES["availability"])
            response["data"]["items"] = []
            for item in payload:
                calendar_price = "85.00" if len(self.calendar_days) > 2 and item["start_time"][:10] == self.calendar_days[2] else "79.00"
                for line in item["sku_list"]:
                    price = float(line.get("price", calendar_price))
                    # A price-less checkout refresh gets the new live price;
                    # the detail-screen request still uses its offered price.
                    if self.price_change and "price" not in line:
                        price = self.repriced_units.setdefault(line["sku_code"], price + 6.0)
                    response["data"]["items"].append(
                        {"sku_code": line["sku_code"], "selling_price": f"{price:.2f}",
                         "currency": "USD", "available": True}
                    )
            self.fulfill(route, response)
        elif path == "/api/orders/validate" and request.method == "POST":
            try:
                self.assert_order_wire(payload)
            except AssertionError as error:
                self.unexpected.append(str(error))
                self.fulfill(route, {"success": False, "error": {"code": "TEST_WIRE_CONTRACT", "message": str(error)}}, 422)
                return
            self.validation_count += 1
            self.fulfill(route, self.quote(payload))
        elif path == "/api/orders" and request.method == "POST":
            try:
                self.assert_order_wire(payload)
            except AssertionError as error:
                self.unexpected.append(str(error))
                self.fulfill(route, {"success": False, "error": {"code": "TEST_WIRE_CONTRACT", "message": str(error)}}, 422)
                return
            self.fulfill(route, {"success": True, "data": {"mode": "validated", "draft_id": "ANT-browser-test",
                          "quote": self.quote(payload)["data"]["quote"],
                          "message": "预订信息已确认。此演示未创建订单或发起支付，下一步由 RollingGo 现有收银台接续。"}})
        else:
            self.unexpected.append(f"Unmatched API request: {request.method} {path}")
            self.fulfill(route, {"success": False, "error": {"code": "TEST_UNMATCHED_API", "message": "Unmatched test route"}}, 500)

    def calls(self, path):
        return [entry for entry in self.requests if entry["path"] == path]
