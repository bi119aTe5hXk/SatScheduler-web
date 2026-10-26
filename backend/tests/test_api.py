from app.main import app


def test_import_payload_is_a_json_request_body():
    operation = app.openapi()["paths"]["/api/import"]["post"]

    assert "requestBody" in operation
    assert operation["requestBody"]["required"] is True
    assert {
        parameter["name"] for parameter in operation.get("parameters", [])
    } == {"replace"}


def test_background_plan_and_schedule_status_routes_are_exposed():
    paths = app.openapi()["paths"]

    assert "get" in paths["/api/plans/status"]
    assert "post" in paths["/api/plans/start"]
    assert "get" in paths["/api/schedules/status"]
    assert "post" in paths["/api/schedules/start"]
    assert "post" in paths["/api/schedules/cancel"]


def test_observation_data_proxy_route_is_exposed():
    operation = app.openapi()["paths"]["/api/observation-data"]["get"]

    assert {parameter["name"] for parameter in operation["parameters"]} == {"url"}


def test_satellite_detail_route_is_exposed():
    operation = app.openapi()["paths"]["/api/satellites/{sat_id}"]["get"]

    assert {parameter["name"] for parameter in operation["parameters"]} == {
        "sat_id",
        "force",
    }


def test_reception_search_route_exposes_online_filters():
    operation = app.openapi()["paths"]["/api/observations/receptions"]["get"]

    assert {
        "observation_id",
        "satellite",
        "sat_id",
        "norad_cat_id",
        "transmitter_mode",
        "transmitter_uuid",
        "observer",
        "status",
    }.issubset({parameter["name"] for parameter in operation["parameters"]})
