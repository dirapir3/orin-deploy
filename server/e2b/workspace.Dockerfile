# Orin's computer: the E2B sandbox template "orin-workspace".
# Built with the admin API (POST /admin/app/api/e2b/template/build) using the server's E2B key.
# Ubuntu 24.04 + Node LTS (npm/yarn/pnpm), Expo + EAS CLI, Capacitor CLI, JDK 21 (default, Capacitor) + JDK 17 (Expo), Android SDK/NDK, Python 3,
# Chromium + Playwright with a live view (Xvfb + noVNC), and file tools (PDF, images, office, media, zip).
FROM ubuntu:24.04
USER root
ENV DEBIAN_FRONTEND=noninteractive TZ=UTC LANG=C.UTF-8 LC_ALL=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
    sudo ca-certificates curl wget gnupg git git-lfs openssh-client unzip zip p7zip-full xz-utils bzip2 \
    build-essential pkg-config cmake ninja-build file jq ripgrep fd-find tree less nano vim-tiny htop procps psmisc lsof \
    iproute2 iputils-ping dnsutils netcat-openbsd rsync time tzdata sqlite3 \
    python3 python3-pip python3-venv python3-dev pipx \
    openjdk-17-jdk-headless \
    poppler-utils qpdf ghostscript imagemagick ffmpeg pandoc tesseract-ocr \
    libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
    fonts-dejavu fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    xvfb x11vnc novnc websockify fluxbox xdotool \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
 && echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-user && chmod 440 /etc/sudoers.d/90-user \
 && rm -rf /var/lib/apt/lists/*

# Node.js 22 LTS with npm, plus yarn and pnpm through corepack, and global CLIs.
ENV NPM_CONFIG_PREFIX=/opt/npm-global PATH=/opt/npm-global/bin:$PATH
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/npm-global && corepack enable && corepack prepare yarn@1.22.22 --activate && corepack prepare pnpm@latest --activate \
 && npm i -g eas-cli@latest typescript tsx serve http-server \
 && npm cache clean --force && chmod -R a+rwX /opt/npm-global

# Python libraries for data, documents and the browser.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright PIP_BREAK_SYSTEM_PACKAGES=1
RUN pip3 install --no-cache-dir --ignore-installed requests httpx beautifulsoup4 lxml pandas numpy matplotlib pillow \
    pypdf pdfplumber reportlab img2pdf python-docx openpyxl xlsxwriter python-pptx markdown pyyaml qrcode \
    flask fastapi uvicorn jinja2 playwright \
 && python3 -m playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/* && chmod -R a+rwX /opt/ms-playwright

# Android SDK: command-line tools, platform-tools, platform 36, build-tools 36, NDK 27.1, CMake 3.22.1.
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:$PATH
RUN mkdir -p /opt/android-sdk/cmdline-tools && cd /tmp \
 && curl -fsSL -o ct.zip https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip \
 && unzip -q ct.zip -d /opt/android-sdk/cmdline-tools && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest && rm ct.zip
# Java here prefers IPv6, which the build network lacks: force IPv4 for sdkmanager and Gradle.
ENV SDKMANAGER_OPTS=-Djava.net.preferIPv4Stack=true
RUN java -version 2>&1 | head -1 && (yes | sdkmanager --licenses > /dev/null 2>&1 || true) \
 && (sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;36.0.0" "cmake;3.22.1" "ndk;27.1.12297006" > /tmp/sdk.log 2>&1 \
     || (echo "sdkmanager could not download; installing the same packages from Google's zips"; tail -4 /tmp/sdk.log; set -e; \
         R=https://dl.google.com/android/repository; S=/opt/android-sdk; cd /tmp; \
         g() { rm -rf x && mkdir x && curl -fsSL --retry 3 -o p.zip "$R/$1" && unzip -q p.zip -d x && rm p.zip; mkdir -p "$(dirname "$2")"; rm -rf "$2"; \
               if [ "$(ls x | wc -l)" = 1 ] && [ -d "x/$(ls x)" ]; then mv "x/$(ls x)" "$2"; else mv x "$2"; fi; }; \
         g platform-tools_r37.0.1-linux.zip $S/platform-tools; g platform-36_r02.zip $S/platforms/android-36; \
         g build-tools_r36_linux.zip $S/build-tools/36.0.0; g cmake-3.22.1-linux.zip $S/cmake/3.22.1; \
         g android-ndk-r27b-linux.zip $S/ndk/27.1.12297006)) \
 && rm -f /tmp/sdk.log && ls /opt/android-sdk /opt/android-sdk/ndk /opt/android-sdk/build-tools && chmod -R a+rwX /opt/android-sdk

# Gradle settings sized for the sandbox (2 vCPU / limited RAM), shared cache for every user.
ENV GRADLE_USER_HOME=/opt/gradle-home
# About 3.9 GB of RAM: one Gradle JVM (no daemon, Kotlin compiled inside it), one worker, arm64 only.
RUN mkdir -p /opt/gradle-home && printf '%s\n' \
    'org.gradle.jvmargs=-Xmx2g -XX:MaxMetaspaceSize=512m -XX:+UseSerialGC -Dfile.encoding=UTF-8 -Djava.net.preferIPv4Stack=true' 'systemProp.java.net.preferIPv4Stack=true' \
    'org.gradle.workers.max=1' 'org.gradle.parallel=false' 'org.gradle.daemon=false' 'org.gradle.caching=true' \
    'kotlin.compiler.execution.strategy=in-process' 'android.enableJetifier=false' 'reactNativeArchitectures=arm64-v8a' > /opt/gradle-home/gradle.properties \
 && chmod -R a+rwX /opt/gradle-home

# Newer Expo (58+) builds against Android 37. Accept the SDK licences (so Gradle can also fetch any other
# platform it needs at build time into the writable SDK) and preinstall platform 37 + build-tools 37.
RUN mkdir -p /opt/android-sdk/licenses \
 && printf '\n24333f8a63b6825ea9c5514f83c2829b004d1fee\n8933bad161af4178b1185d1a37fbf41ea5269c55\nd56f5187479451eabf01fb78af6dfcb131a6481e' > /opt/android-sdk/licenses/android-sdk-license \
 && printf '\n84831b9409646a918e30573bab4c9c91346d8abd' > /opt/android-sdk/licenses/android-sdk-preview-license \
 && printf '\n859f317696f67ef3d7f30a50a5560e7834b43903' > /opt/android-sdk/licenses/android-sdk-arm-dbt-license \
 && (yes | sdkmanager --licenses > /dev/null 2>&1 || true) \
 && (sdkmanager --install "platforms;android-37.0" "build-tools;37.0.0" > /tmp/sdk37.log 2>&1 || (echo 'sdkmanager could not download; installing platform 37 + build-tools 37 from Google zips'; set -e; \
     R=https://dl.google.com/android/repository; S=/opt/android-sdk; cd /tmp; \
     g() { rm -rf x && mkdir x && curl -fsSL --retry 3 -o p.zip "$R/$1" && unzip -q p.zip -d x && rm p.zip; mkdir -p "$(dirname "$2")"; rm -rf "$2"; \
           if [ "$(ls x | wc -l)" = 1 ] && [ -d "x/$(ls x)" ]; then mv "x/$(ls x)" "$2"; else mv x "$2"; fi; }; \
     g platform-37.0_r02.zip $S/platforms/android-37.0; g build-tools_r37_linux.zip $S/build-tools/37.0.0)) \
 && ls /opt/android-sdk/platforms /opt/android-sdk/build-tools && chmod -R a+rwX /opt/android-sdk

# Docker ENV lines do not reach the sandbox's commands, so the same settings go in the system-wide
# startup files too: /etc/profile.d (login shells, which E2B commands use), the top of /etc/bash.bashrc
# (interactive shells) and /etc/environment.
RUN printf '%s\n' \
    'export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64' \
    'export ANDROID_HOME=/opt/android-sdk' 'export ANDROID_SDK_ROOT=/opt/android-sdk' \
    'export ANDROID_NDK_HOME=/opt/android-sdk/ndk/27.1.12297006' \
    'export GRADLE_USER_HOME=/opt/gradle-home' 'export GRADLE_OPTS="-Dorg.gradle.daemon=false -Djava.net.preferIPv4Stack=true"' \
    'export SDKMANAGER_OPTS=-Djava.net.preferIPv4Stack=true' \
    'export NPM_CONFIG_PREFIX=/opt/npm-global' 'export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright' 'export PIP_BREAK_SYSTEM_PACKAGES=1' \
    'export EXPO_NO_TELEMETRY=1' 'export LANG=C.UTF-8 LC_ALL=C.UTF-8' \
    'case ":$PATH:" in *:/opt/npm-global/bin:*) ;; *) export PATH=/opt/npm-global/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/usr/lib/jvm/java-17-openjdk-amd64/bin:$PATH ;; esac' \
    > /etc/profile.d/00-orin-env.sh \
 && chmod 644 /etc/profile.d/00-orin-env.sh \
 && { echo '. /etc/profile.d/00-orin-env.sh'; cat /etc/bash.bashrc; } > /tmp/bb && mv /tmp/bb /etc/bash.bashrc \
 && printf '%s\n' 'JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64' 'ANDROID_HOME=/opt/android-sdk' 'ANDROID_SDK_ROOT=/opt/android-sdk' \
    'GRADLE_USER_HOME=/opt/gradle-home' 'NPM_CONFIG_PREFIX=/opt/npm-global' 'PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright' \
    'PATH="/opt/npm-global/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' \
    > /etc/environment \
 && for b in eas expo-doctor tsc tsx serve http-server; do [ -e /opt/npm-global/bin/$b ] && ln -sf /opt/npm-global/bin/$b /usr/local/bin/$b; done; \
    ln -sf /opt/android-sdk/platform-tools/adb /usr/local/bin/adb; ln -sf /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager /usr/local/bin/sdkmanager; true

# Helper for Orin: build an Expo app's Android APK sized for this machine (adds swap if it can).
# (the build script swaps in the base64 of e2b/orin-android-build; see tools/e2b_tpl_build.sh)
RUN echo '__ORIN_ANDROID_BUILD_B64__' | base64 -d > /usr/local/bin/orin-android-build && chmod 755 /usr/local/bin/orin-android-build

# Capacitor (web app -> Android APK) beside Expo. Capacitor 8 needs JDK 21, so JDK 21 is the DEFAULT java,
# javac and JAVA_HOME everywhere (image ENV, login shells, /etc/environment): `npx cap build`, `cap run`,
# `./gradlew` in a Capacitor project all just work. JDK 17 stays installed ($JAVA17_HOME); orin-android-build
# switches to it for Expo / React Native builds.
# (the build script swaps in the base64 of e2b/orin-capacitor-build; see tools/e2b_tpl_build.sh)
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-21-jdk-headless && rm -rf /var/lib/apt/lists/* \
 && update-alternatives --set java /usr/lib/jvm/java-21-openjdk-amd64/bin/java \
 && update-alternatives --set javac /usr/lib/jvm/java-21-openjdk-amd64/bin/javac \
 && sed -i 's#java-17-openjdk-amd64#java-21-openjdk-amd64#g' /etc/profile.d/00-orin-env.sh /etc/environment \
 && printf '%s\n' 'export JAVA21_HOME=/usr/lib/jvm/java-21-openjdk-amd64' 'export JAVA17_HOME=/usr/lib/jvm/java-17-openjdk-amd64' >> /etc/profile.d/00-orin-env.sh \
 && printf '%s\n' 'JAVA21_HOME=/usr/lib/jvm/java-21-openjdk-amd64' 'JAVA17_HOME=/usr/lib/jvm/java-17-openjdk-amd64' >> /etc/environment \
 && java -version 2>&1 | head -1 && javac -version \
 && npm i -g @capacitor/cli@8 && npm cache clean --force && chmod -R a+rwX /opt/npm-global \
 && ln -sf /opt/npm-global/bin/cap /usr/local/bin/cap
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 JAVA21_HOME=/usr/lib/jvm/java-21-openjdk-amd64 JAVA17_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH=/usr/lib/jvm/java-21-openjdk-amd64/bin:$PATH
RUN echo '__ORIN_CAPACITOR_BUILD_B64__' | base64 -d > /usr/local/bin/orin-capacitor-build && chmod 755 /usr/local/bin/orin-capacitor-build

# Commands run as the last USER. Orin's server expects the normal E2B user "user" (home /home/user, work
# folder /home/user/work) with sudo and no password, as on E2B's standard machine.
RUN (id user >/dev/null 2>&1 || useradd -m -s /bin/bash user) \
 && echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/user && chmod 440 /etc/sudoers.d/user \
 && mkdir -p /home/user/work /home/user/workspace /home/user/.orin /opt/orin && chmod 777 /opt/orin \
 && chown -R user:user /home/user && chmod -R a+rwX /opt/npm-global /opt/gradle-home && chmod -R a+rX /opt/ms-playwright
USER user
WORKDIR /home/user
