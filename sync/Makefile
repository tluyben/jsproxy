.PHONY: all clean test build-x86_64 build-aarch64

BINARY_NAME = sync
TARGET_X86_64 = x86_64-unknown-linux-gnu
TARGET_AARCH64 = aarch64-unknown-linux-gnu
OUT_DIR = target/release-bins

all: test build-x86_64 build-aarch64

test:
	cargo test

build-x86_64:
	cargo build --release --target $(TARGET_X86_64)
	mkdir -p $(OUT_DIR)
	cp target/$(TARGET_X86_64)/release/$(BINARY_NAME) $(OUT_DIR)/$(BINARY_NAME)-linux-x86_64

build-aarch64:
	cross build --release --target $(TARGET_AARCH64)
	mkdir -p $(OUT_DIR)
	cp target/$(TARGET_AARCH64)/release/$(BINARY_NAME) $(OUT_DIR)/$(BINARY_NAME)-linux-aarch64

clean:
	cargo clean
	rm -rf $(OUT_DIR)
