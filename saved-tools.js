/*
  /saved-tools.js
  Shared save/load/delete logic for AutomationCalculators.net
  Requires:
  - Supabase CDN loaded first
  - /supabase.js loaded before this file
  - window.supabaseClient available
*/

let savedToolsCurrentUser = null;

function savedToolsSetStatus(id, message, type){
  const el = document.getElementById(id);
  if(!el) return;

  el.textContent = message || "";
  el.className = "save-status " + (type || "muted");
}

async function savedToolsCheckUser(){
  if(!window.supabaseClient){
    savedToolsCurrentUser = null;
    savedToolsUpdateAuthUI();
    savedToolsSetStatus("savedStatus", "Supabase is not loaded. Check /supabase.js.", "error");
    return null;
  }

  const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();

  if(sessionError){
    console.error("Session check error:", sessionError);
  }

  if(sessionData && sessionData.session && sessionData.session.user){
    savedToolsCurrentUser = sessionData.session.user;
    savedToolsUpdateAuthUI();
    return savedToolsCurrentUser;
  }

  savedToolsCurrentUser = null;
  savedToolsUpdateAuthUI();
  return null;
}

function savedToolsUpdateAuthUI(){
  const authButton = document.getElementById("authButton");
  const authUserLabel = document.getElementById("authUserLabel");

  if(savedToolsCurrentUser){
    if(authButton){authButton.textContent = "My Account";}
    if(authUserLabel){authUserLabel.textContent = "Signed in as " + savedToolsCurrentUser.email;}
  } else {
    if(authButton){authButton.textContent = "Sign In";}
    if(authUserLabel){authUserLabel.textContent = "Sign in to save and reload calculations.";}
  }
}

function savedToolsHandleAuthButton(config){
  if(savedToolsCurrentUser){
    savedToolsLoad(config);
    savedToolsSetStatus("savedStatus", "You are signed in. Your saved calculations are shown below.", "success");
  } else if(typeof openAuthModal === "function"){
    openAuthModal();
  } else {
    savedToolsSetStatus("savedStatus", "Please sign in from the account button first.", "error");
  }
}
async function savedToolsSave(config){
  if(!config || !config.toolName || !config.toolUrl || typeof config.collectData !== "function"){
    savedToolsSetStatus("saveStatus", "Save setup is missing required tool configuration.", "error");
    return;
  }

  const savedData = config.collectData();

  if(!savedData){
    savedToolsSetStatus("saveStatus", "Calculate first or fix the inputs before saving.", "error");
    return;
  }

  const user = await savedToolsCheckUser();

  if(!user){
    savedToolsSetStatus("saveStatus", "Sign in to save this calculation.", "error");

    if(typeof openAuthModal === "function"){
      openAuthModal();
    }

    return;
  }

  savedToolsSetStatus("saveStatus", "Saving calculation...", "muted");

  const { data, error } = await supabaseClient
    .from("saved_tools")
    .insert({
      user_id: user.id,
      tool_name: config.toolName,
      tool_url: config.toolUrl,
      saved_data: savedData
    })
    .select();

  console.log("Save response:", { data, error });

  if(error){
    savedToolsSetStatus("saveStatus", "Save failed: " + error.message, "error");
    return;
  }

  if(typeof gtag === "function"){
    gtag("event", "calculation_saved", {
      tool: config.analyticsTool || config.toolUrl,
      tool_url: config.toolUrl
    });
  }

  savedToolsSetStatus("saveStatus", "Calculation saved successfully.", "success");
  await savedToolsLoad(config);
}

async function savedToolsLoad(config){
  if(!config || !config.toolUrl){
    savedToolsSetStatus("savedStatus", "Saved tool configuration is missing.", "error");
    return;
  }

  const user = await savedToolsCheckUser();

  const list = document.getElementById("savedList");
  if(list){list.innerHTML = "";}

  if(!user){
    savedToolsSetStatus("savedStatus", "Sign in to view saved calculations.", "muted");
    return;
  }

  savedToolsSetStatus("savedStatus", "Loading saved calculations...", "muted");

  const { data, error } = await supabaseClient
    .from("saved_tools")
    .select("id, tool_name, tool_url, saved_data, created_at")
    .eq("user_id", user.id)
    .eq("tool_url", config.toolUrl)
    .order("created_at", { ascending:false });

  if(error){
    savedToolsSetStatus("savedStatus", "Could not load saved calculations: " + error.message, "error");
    return;
  }

  if(!data || data.length === 0){
    savedToolsSetStatus("savedStatus", "No saved calculations yet.", "muted");
    return;
  }

  savedToolsSetStatus("savedStatus", data.length + " saved calculation" + (data.length === 1 ? "" : "s") + " found.", "success");

  data.forEach(item => {
    savedToolsRenderItem(item, config);
  });
}

function savedToolsRenderItem(item, config){
  const list = document.getElementById("savedList");
  if(!list) return;

  const d = item.saved_data || {};
  const createdDate = item.created_at ? new Date(item.created_at) : null;
  const createdLabel = createdDate ? createdDate.toLocaleString() : "Saved calculation";

  const div = document.createElement("div");
  div.className = "saved-item";

  const titleRow = document.createElement("div");
  titleRow.className = "saved-title-row";

  const titleWrap = document.createElement("div");

  const title = document.createElement("div");
  title.className = "saved-title";
  title.textContent = config.savedItemTitle || config.toolName || "Saved Calculation";

  const meta = document.createElement("div");
  meta.className = "saved-meta";
  meta.textContent = createdLabel;

  titleWrap.appendChild(title);
  titleWrap.appendChild(meta);
  titleRow.appendChild(titleWrap);

  const values = document.createElement("div");
  values.className = "saved-values";

  const fields = typeof config.renderFields === "function"
    ? config.renderFields(d)
    : savedToolsDefaultFields(d);

  fields.forEach(field => {
    const box = document.createElement("div");
    box.className = "saved-value";

    const label = document.createElement("strong");
    label.textContent = field.label + ":";

    const br = document.createElement("br");
    const value = document.createTextNode(field.value);

    box.appendChild(label);
    box.appendChild(br);
    box.appendChild(value);
    values.appendChild(box);
  });

  const actions = document.createElement("div");
  actions.className = "saved-actions";

  const reloadBtn = document.createElement("button");
  reloadBtn.className = "btn btn-primary";
  reloadBtn.type = "button";
  reloadBtn.textContent = "Reload Setup";
  reloadBtn.addEventListener("click", function(){
    if(typeof config.reloadData === "function"){
      config.reloadData(d);
    }

    if(typeof gtag === "function"){
      gtag("event", "saved_calculation_reloaded", {
        tool: config.analyticsTool || config.toolUrl,
        tool_url: config.toolUrl
      });
    }

    savedToolsSetStatus("saveStatus", "Saved setup reloaded.", "success");

    const calculator = document.getElementById("calculator");
    if(calculator){
      calculator.scrollIntoView({
        behavior:"smooth",
        block:"start"
      });
    }
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn btn-danger";
  deleteBtn.type = "button";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", function(){
    savedToolsDelete(item.id, config);
  });

  actions.appendChild(reloadBtn);
  actions.appendChild(deleteBtn);

  div.appendChild(titleRow);
  div.appendChild(values);
  div.appendChild(actions);

  list.appendChild(div);
}

function savedToolsDefaultFields(d){
  return Object.keys(d).slice(0, 8).map(key => {
    return {
      label: key.replaceAll("_", " "),
      value: savedToolsSafeValue(d[key])
    };
  });
}

function savedToolsSafeValue(value){
  if(value === undefined || value === null || value === "") return "—";

  if(typeof value === "number"){
    return Number(value).toLocaleString(undefined, {
      maximumFractionDigits: 3
    });
  }

  return String(value);
}

async function savedToolsDelete(id, config){
  const user = await savedToolsCheckUser();

  if(!user){
    if(typeof openAuthModal === "function"){
      openAuthModal();
    }
    return;
  }

  const { error } = await supabaseClient
    .from("saved_tools")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if(error){
    savedToolsSetStatus("savedStatus", "Delete failed: " + error.message, "error");
    return;
  }

  if(typeof gtag === "function"){
    gtag("event", "saved_calculation_deleted", {
      tool: config.analyticsTool || config.toolUrl,
      tool_url: config.toolUrl
    });
  }

  savedToolsSetStatus("savedStatus", "Saved calculation deleted.", "success");
  await savedToolsLoad(config);
}

function savedToolsInit(config){
  document.addEventListener("DOMContentLoaded", async function(){
    await savedToolsCheckUser();
    await savedToolsLoad(config);

    if(window.supabaseClient && supabaseClient.auth && supabaseClient.auth.onAuthStateChange){
      supabaseClient.auth.onAuthStateChange(async function(event, session){
        savedToolsCurrentUser = session && session.user ? session.user : null;
        savedToolsUpdateAuthUI();

        if(event === "SIGNED_IN"){
          await savedToolsLoad(config);
        }

        if(event === "SIGNED_OUT"){
          const list = document.getElementById("savedList");
          if(list){list.innerHTML = "";}
          savedToolsSetStatus("savedStatus", "Sign in to view saved calculations.", "muted");
        }
      });
    }
  });
}
