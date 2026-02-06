import unittest
from pathlib import Path


class DeployFilesTests(unittest.TestCase):
    def test_containerfile_has_runtime_defaults(self) -> None:
        root = Path(__file__).resolve().parent.parent
        content = (root / "Containerfile").read_text(encoding="utf-8")
        self.assertIn("FROM python:3.12-slim", content)
        self.assertIn("BINDERY_LIBRARY_DIR=/data/library", content)
        self.assertIn('VOLUME ["/data/library"]', content)
        self.assertIn('CMD ["uv", "run", "uvicorn", "bindery.web:app"', content)

    def test_workflow_pushes_to_ghcr(self) -> None:
        root = Path(__file__).resolve().parent.parent
        workflow = (root / ".github" / "workflows" / "publish-ghcr.yml").read_text(encoding="utf-8")
        self.assertIn("packages: write", workflow)
        self.assertIn("registry: ghcr.io", workflow)
        self.assertIn("docker/build-push-action@v6", workflow)
        self.assertIn("file: ./Containerfile", workflow)
        self.assertIn("push: true", workflow)

    def test_quadlet_examples_present(self) -> None:
        root = Path(__file__).resolve().parent.parent
        container_unit = (root / "deploy" / "quadlet" / "bindery.container").read_text(encoding="utf-8")
        volume_unit = (root / "deploy" / "quadlet" / "bindery-library.volume").read_text(encoding="utf-8")
        self.assertIn("PublishPort=5670:5670", container_unit)
        self.assertIn("Volume=bindery-library.volume:/data/library:Z", container_unit)
        self.assertIn("EnvironmentFile=/etc/bindery/bindery.env", container_unit)
        self.assertIn("VolumeName=bindery-library", volume_unit)


if __name__ == "__main__":
    unittest.main()
