const profileSelector = document.getElementById('profile-selector');
const hostList = document.getElementById('host-list');
const addHostBtn = document.getElementById('add-host');
const newProfileBtn = document.getElementById('new-profile');
const saveProfileBtn = document.getElementById('save-profile');
const deleteProfileBtn = document.getElementById('delete-profile');
const modal = document.getElementById('host-modal');
const modalOverlay = document.getElementById('modal-overlay');
const hostForm = document.getElementById('host-form');
const logoutBtn = document.getElementById('logout');
const muteAllBtn = document.getElementById('mute-all');

// SPEC §7.1: Mute All button dispatches alert:mute with cellId 'all'
muteAllBtn.onclick = () => {
    window.dispatchEvent(new CustomEvent('alert:mute', { detail: { cellId: 'all' } }));
    muteAllBtn.textContent = muteAllBtn.textContent === 'Mute All' ? 'Unmute All' : 'Mute All';
};

let _sshPort = 2222;

async function loadData() {
    const [hostsRes, profilesRes] = await Promise.all([
        fetch('/api/hosts'),
        fetch('/api/profiles')
    ]);
    const hostsData = await hostsRes.json();
    const hosts = hostsData.hosts;
    if (hostsData.sshPort) _sshPort = hostsData.sshPort;
    const profiles = await profilesRes.json();

    // Render Profiles
    const currentProfileId = profileSelector.value;
    profileSelector.innerHTML = '<option value="">Select Profile...</option>';
    for (const id in profiles) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = profiles[id].label;
        if (id === currentProfileId) opt.selected = true;
        profileSelector.appendChild(opt);
    }

    // Render Host List
    hostList.innerHTML = '';
    const selectedHostIds = currentProfileId && profiles[currentProfileId] ? profiles[currentProfileId].hostIds : [];

    for (const id in hosts) {
        const item = document.createElement('div');
        item.className = 'sidebar-host-item';
        const isChecked = selectedHostIds.includes(id);
        item.innerHTML = `
            <label><input type="checkbox" class="profile-host-toggle" data-id="${id}" ${isChecked ? 'checked' : ''}> ${hosts[id].label}</label>
            <div class="host-item-actions">
                <select class="tier-select" data-id="${id}">
                    <option value="low" ${hosts[id].alertTier === 'low' ? 'selected' : ''}>Low</option>
                    <option value="medium" ${hosts[id].alertTier === 'medium' ? 'selected' : ''}>Medium</option>
                    <option value="high" ${hosts[id].alertTier === 'high' ? 'selected' : ''}>High</option>
                    <option value="none" ${hosts[id].alertTier === 'none' ? 'selected' : ''}>None</option>
                </select>
                <button class="copy-ssh" data-id="${id}" data-port="${hosts[id].tunnelPort}" data-vnc-port="${hosts[id].vncPort || 5900}" title="Copy SSH tunnel command">⎘</button>
                <button class="edit-host" data-id="${id}">✎</button>
                <button class="delete-host danger" data-id="${id}">×</button>
            </div>
        `;
        hostList.appendChild(item);
    }
}

// Profile management
newProfileBtn.onclick = async () => {
    const label = prompt('New Profile Name:');
    if (!label) return;
    await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, hostIds: [], globalMute: false })
    });
    loadData();
};

saveProfileBtn.onclick = async () => {
    const profileId = profileSelector.value;
    if (!profileId) return alert('Select a profile to save');

    const hostIds = Array.from(document.querySelectorAll('.profile-host-toggle:checked')).map(el => el.dataset.id);
    const res = await fetch('/api/profiles');
    const profiles = await res.json();
    const profile = profiles[profileId];

    await fetch(`/api/profiles/${profileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...profile, hostIds })
    });
    alert('Profile saved');
};

deleteProfileBtn.onclick = async () => {
    const profileId = profileSelector.value;
    if (!profileId) return;
    if (confirm('Delete this profile?')) {
        await fetch(`/api/profiles/${profileId}`, { method: 'DELETE' });
        profileSelector.value = '';
        loadData();
    }
};

// Modal handling
addHostBtn.onclick = () => {
    hostForm.reset();
    document.getElementById('host-id').value = '';
    document.getElementById('modal-title').textContent = 'Add Host';
    modalOverlay.classList.remove('hidden');
    modal.classList.remove('hidden');
};

document.getElementById('close-modal').onclick = () => {
    modalOverlay.classList.add('hidden');
    modal.classList.add('hidden');
};

hostForm.onsubmit = async (e) => {
    e.preventDefault();
    const id = document.getElementById('host-id').value;
    const data = {
        label: document.getElementById('host-label').value,
        ip: document.getElementById('host-ip').value,
        vncPort: parseInt(document.getElementById('host-vnc-port').value),
        password: document.getElementById('host-vnc-password').value,
        sshPublicKey: document.getElementById('host-ssh-key').value,
        alertTier: document.getElementById('host-alert-tier').value,
        fadeEnabled: document.getElementById('host-fade-enabled').checked
    };

    const method = id ? 'PUT' : 'POST';
    const url = id ? `/api/hosts/${id}` : '/api/hosts';

    await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });

    modalOverlay.classList.add('hidden');
    loadData();
};

hostList.onclick = async (e) => {
    const id = e.target.dataset.id;
    if (e.target.classList.contains('copy-ssh')) {
        const tunnelPort = e.target.dataset.port;
        const vncPort = e.target.dataset.vncPort;
        const cmd = `ssh -i C:\\Users\\<USERNAME>\\.ssh\\lambvnc_key -N -R 127.0.0.1:${tunnelPort}:127.0.0.1:${vncPort} sender@<SERVER-IP> -p ${_sshPort} -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new`;
        await navigator.clipboard.writeText(cmd);
        const btn = e.target;
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '⎘'; }, 1500);
    } else if (e.target.classList.contains('delete-host')) {
        if (confirm('Delete this host?')) {
            await fetch(`/api/hosts/${id}`, { method: 'DELETE' });
            loadData();
        }
    } else if (e.target.classList.contains('edit-host')) {
        const res = await fetch('/api/hosts');
        const data = await res.json();
        const host = data.hosts[id];
        document.getElementById('host-id').value = id;
        document.getElementById('host-label').value = host.label;
        document.getElementById('host-ip').value = host.ip;
        document.getElementById('host-vnc-port').value = host.vncPort;
        document.getElementById('host-alert-tier').value = host.alertTier;
        document.getElementById('host-fade-enabled').checked = host.fadeEnabled;
        document.getElementById('modal-title').textContent = 'Edit Host';
        modalOverlay.classList.remove('hidden');
        modal.classList.remove('hidden');
    }
};

// M3: Dispatch alert:set-tier when tier dropdown changes
hostList.onchange = async (e) => {
    if (e.target.classList.contains('tier-select')) {
        const id = e.target.dataset.id;
        const tier = e.target.value;
        // Update on server
        await fetch(`/api/hosts/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alertTier: tier })
        });
        // SPEC: dispatch event to detection.js and alerts.js
        window.dispatchEvent(new CustomEvent('alert:set-tier', { detail: { cellId: id, tier } }));
    }
};

profileSelector.onchange = async () => {
    const id = profileSelector.value;
    loadData();
    if (!id) return;
    const res = await fetch('/api/profiles');
    const profiles = await res.json();
    window.dispatchEvent(new CustomEvent('profile:loaded', { detail: { profile: profiles[id] } }));
};

logoutBtn.onclick = async () => {
    await fetch('/logout', { method: 'POST' });
    window.location.href = '/login';
};

loadData();
