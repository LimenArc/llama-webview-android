plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.limenarc.llamaweb"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.limenarc.llamaweb"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        ndk {
            // The bundled server binary is built for arm64-v8a only (see .github/workflows/build.yml).
            abiFilters += "arm64-v8a"
        }
    }

    // CI runs on a fresh machine every time, so without a pinned debug key each build gets
    // a new random one from a fresh ~/.android/debug.keystore. Android refuses to install an
    // update whose signature doesn't match the currently-installed app, so that turns every
    // CI-produced APK into an "uninstall first" situation. Pinning a checked-in debug
    // keystore keeps every build (CI or local) signed identically so installs always update
    // cleanly. This key is not a secret - it is Android's own debug keystore convention
    // (alias/password "android...") and can never be used to sign a release build.
    signingConfigs {
        getByName("debug") {
            storeFile = file("../keystore/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = false
    }

    // libllama-server.so is a prebuilt executable, not a real shared library. It must be
    // unpacked to nativeLibraryDir at install time (rather than mmap'd from the APK) so it
    // can be exec()'d directly, and it must not be compressed differently than the rest of
    // the native libs or the extraction step will skip it.
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
}
