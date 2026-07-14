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
