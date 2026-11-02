import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.hssc.poster"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.hssc.poster"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"

        // ABI filters are set by `splits` below; declaring them twice conflicts.
        externalNativeBuild {
            cmake {
                // nodejs-mobile's libnode.so is built against the shared C++ runtime.
                arguments += "-DANDROID_STL=c++_shared"
            }
        }
    }

    // One APK per CPU type: the arm64 build (real phones) stays small, and the
    // x86_64 build is only for testing on the emulator.
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "x86_64")
            isUniversalApk = false
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    packaging {
        jniLibs {
            // libnode.so is 60 MB: keep it compressed in the APK and extract it.
            useLegacyPackaging = true
        }
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        // Real key so the APK can be shared and updated in place. The passwords
        // live in android/keystore/keystore.properties (not inside the bundle).
        create("release") {
            val propsFile = rootProject.file("keystore/keystore.properties")
            val props = Properties()
            if (propsFile.exists()) propsFile.inputStream().use { props.load(it) }
            storeFile = rootProject.file("keystore/hssc-release.jks")
            storePassword = props.getProperty("storePassword") ?: ""
            keyAlias = props.getProperty("keyAlias") ?: "hssc"
            keyPassword = props.getProperty("keyPassword") ?: ""
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Deliberately no AndroidX: the app is one activity, one WebView and one
    // service, and every extra dependency is another thing to break.
}
