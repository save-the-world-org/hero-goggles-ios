# The spike's targets: make verify is the gate (the harness first); make sim runs the spike on a simulator with Meta's
# simulated glasses; make device installs it on your iPhone (DEVICE=<identifier>). README.md says more.
.PHONY: verify harness sim device

verify:
	scripts/verify

harness:
	node .infrared/bin/infrared-harness.mjs validate

sim:
	scripts/run-simulator

device:
	scripts/install-device
