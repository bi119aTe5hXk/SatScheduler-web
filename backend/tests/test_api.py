from app.main import app


def test_import_payload_is_a_json_request_body():
    operation = app.openapi()["paths"]["/api/import"]["post"]

    assert "requestBody" in operation
    assert operation["requestBody"]["required"] is True
    assert {
        parameter["name"] for parameter in operation.get("parameters", [])
    } == {"replace"}
