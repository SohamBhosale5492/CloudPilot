import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { discoverArchitecture } from "./architecture-discovery";

async function tempRepository(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(process.cwd(), "dist", "cloudpilot-discovery-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }

  return root;
}

test("discovers valid Docker Compose services and resources", async () => {
  const root = await tempRepository({
    "docker-compose.yml": `
services:
  api:
    image: example/api:1
    ports:
      - "3000:3000"
    depends_on:
      db:
        condition: service_started
  worker:
    build:
      context: ./worker
volumes:
  data: {}
networks:
  backend: {}
`
  });

  const result = await discoverArchitecture({ repositoryRoot: root });

  assert.equal(result.status, "success");
  assert.deepEqual(result.model.services.map((service) => service.id), [
    "compose:service:api",
    "compose:service:worker"
  ]);
  assert.deepEqual(result.model.services[0], {
    id: "compose:service:api",
    name: "api",
    workloadType: "compose-service",
    image: "example/api:1",
    buildContext: undefined,
    ports: ["3000:3000"],
    dependencies: ["db"],
    source: {
      file: "docker-compose.yml",
      format: "docker-compose"
    }
  });
  assert.deepEqual(result.model.resources.map((resource) => resource.id), [
    "compose:network:backend",
    "compose:volume:data"
  ]);
});

test("discovers Kubernetes workloads and resources from multi-document YAML", async () => {
  const root = await tempRepository({
    "k8s/app.yaml": `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  template:
    spec:
      containers:
        - name: web
          image: example/web:2
          ports:
            - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  ports:
    - port: 80
`
  });

  const result = await discoverArchitecture({ repositoryRoot: root });

  assert.equal(result.status, "success");
  assert.deepEqual(result.model.services[0], {
    id: "kubernetes:deployment:web",
    name: "web",
    workloadType: "kubernetes-workload",
    image: "example/web:2",
    ports: ["8080"],
    dependencies: [],
    source: {
      file: "k8s/app.yaml",
      format: "kubernetes",
      documentIndex: 0
    }
  });
  assert.deepEqual(result.model.resources[0], {
    id: "kubernetes:service:web",
    name: "web",
    resourceType: "kubernetes-resource",
    kind: "Service",
    ports: ["80"],
    source: {
      file: "k8s/app.yaml",
      format: "kubernetes",
      documentIndex: 1
    }
  });
});

test("discovers Kubernetes CronJob containers from jobTemplate pod spec", async () => {
  const root = await tempRepository({
    "k8s/cronjob.yaml": `
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-report
spec:
  schedule: "0 1 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: report
              image: example/report:3
              ports:
                - containerPort: 9091
`
  });

  const result = await discoverArchitecture({ repositoryRoot: root });

  assert.equal(result.status, "success");
  assert.deepEqual(result.model.services[0], {
    id: "kubernetes:cronjob:nightly-report",
    name: "nightly-report",
    workloadType: "kubernetes-workload",
    image: "example/report:3",
    ports: ["9091"],
    dependencies: [],
    source: {
      file: "k8s/cronjob.yaml",
      format: "kubernetes",
      documentIndex: 0
    }
  });
});

test("handles missing optional fields without inference", async () => {
  const root = await tempRepository({
    "compose.yml": `
services:
  api: {}
`
  });

  const result = await discoverArchitecture({ repositoryRoot: root });

  assert.equal(result.status, "success");
  assert.deepEqual(result.model.services[0].ports, []);
  assert.deepEqual(result.model.services[0].dependencies, []);
  assert.equal(result.model.services[0].image, undefined);
});

test("reports malformed YAML as invalid", async () => {
  const root = await tempRepository({
    "docker-compose.yml": "services:\n  api: ["
  });

  const result = await discoverArchitecture({ repositoryRoot: root });

  assert.equal(result.status, "invalid");
  assert.equal(result.diagnostics[0].code, "MALFORMED_YAML");
});

test("reports unsupported YAML formats", async () => {
  const root = await tempRepository({
    "observability.yml": `
dashboard:
  name: unsupported
`
  });

  const result = await discoverArchitecture({ repositoryRoot: root });

  assert.equal(result.status, "unsupported");
  assert.equal(result.diagnostics[0].code, "UNSUPPORTED_FORMAT");
});

test("reports unsupported constructs as partial discovery", async () => {
  const root = await tempRepository({
    "docker-compose.yml": `
services:
  api:
    image: example/api
    extends:
      file: base.yml
      service: base-api
`
  });

  const result = await discoverArchitecture({ repositoryRoot: root });

  assert.equal(result.status, "partial");
  assert.equal(result.diagnostics[0].code, "UNSUPPORTED_CONSTRUCT");
  assert.equal(result.model.services.length, 1);
});

test("reports duplicate stable identifiers", async () => {
  const root = await tempRepository({
    "one.yaml": `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
`,
    "two.yaml": `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
`
  });

  const result = await discoverArchitecture({ repositoryRoot: root });

  assert.equal(result.status, "invalid");
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "DUPLICATE_IDENTIFIER"));
});

test("produces deterministic output for identical inputs", async () => {
  const root = await tempRepository({
    "b.yaml": `
apiVersion: v1
kind: Service
metadata:
  name: beta
`,
    "a.yaml": `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: alpha
`
  });

  assert.deepEqual(
    await discoverArchitecture({ repositoryRoot: root }),
    await discoverArchitecture({ repositoryRoot: root })
  );
});

test("rejects repository path traversal attempts", async () => {
  const root = await tempRepository({
    "docker-compose.yml": "services: {}"
  });

  const result = await discoverArchitecture({
    repositoryRoot: root,
    includePaths: ["../outside/docker-compose.yml"]
  });

  assert.equal(result.status, "invalid");
  assert.equal(result.diagnostics[0].code, "PATH_OUTSIDE_ROOT");
});

test("rejects included symlinks that resolve outside the repository root", async (context) => {
  const root = await tempRepository();
  const outsideRoot = await tempRepository({
    "outside-compose.yml": "services: {}"
  });
  const linkPath = path.join(root, "linked-compose.yml");

  try {
    await symlink(path.join(outsideRoot, "outside-compose.yml"), linkPath, "file");
  } catch {
    context.skip("Platform cannot create the required symbolic link.");
    return;
  }

  const result = await discoverArchitecture({
    repositoryRoot: root,
    includePaths: ["linked-compose.yml"]
  });

  assert.equal(result.status, "invalid");
  assert.equal(result.diagnostics[0].code, "PATH_OUTSIDE_ROOT");
});

test("reports empty repositories", async () => {
  const root = await tempRepository();

  const result = await discoverArchitecture({ repositoryRoot: root });

  assert.equal(result.status, "success");
  assert.equal(result.diagnostics[0].code, "EMPTY_REPOSITORY");
  assert.deepEqual(result.model.services, []);
});

test("reports partial discovery for skipped oversized files", async () => {
  const root = await tempRepository({
    "docker-compose.yml": `
services:
  api:
    image: example/api
`,
    "k8s.yaml": `
apiVersion: v1
kind: Service
metadata:
  name: large
`
  });

  const result = await discoverArchitecture({
    repositoryRoot: root,
    maxFileBytes: 45
  });

  assert.equal(result.status, "partial");
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "FILE_TOO_LARGE"));
});
